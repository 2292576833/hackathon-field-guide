import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Actor } from "../src/shared/contracts.ts";
import { isDomainError } from "../src/shared/errors.ts";
import { createApplication } from "../src/server/application.ts";
import { createDatabase, type ApplicationDatabase } from "../src/server/database.ts";
import { loadConfig } from "../src/server/config.ts";
import type { PersonalArtifactKind } from "../src/shared/personal-ai.ts";

// The explicit flag is an operator action. Importing/running without it is a
// zero-request setup check, never an invitation to retry an uncertain request.
const REQUEST_LIMIT = 2;
const BUDGET_LIMIT_MICRO_USD = 100_000;
const INPUT_LIMIT_BYTES = 65_536;
const OUTPUT_LIMIT_TOKENS = 4096;
const TIMEOUT_LIMIT_MS = 90_000;
let verificationStage = "arguments";
type Outcome = { kind: "profile_summary" | "project_feasibility"; outcome: "saved" | "failed"; code: string | null; provider?: "dsh"; artifactBytes?: number; characters?: number; findings?: number; validationTasks?: number };
type UsageRow = { id: string; execution_id: string; status: string; cost_configured: boolean; reserved_micro_usd: number | string | null; charged_micro_usd: number | string | null; input_tokens: number | string | null; output_tokens: number | string | null; usage_verified: boolean; external_state: string; error_code: string | null };
type JobRow = { id: string; kind: string; status: string; external_state: string; error_code: string | null };
type BucketRow = { calls: number; reserved_micro_usd: number | string; charged_micro_usd: number | string };
const safeCode = (failure: unknown) => isDomainError(failure) ? failure.code : failure instanceof assert.AssertionError ? "COMPLETION_DSH_ASSERTION_FAILED" : "COMPLETION_DSH_VERIFICATION_FAILED";
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function state(database: ApplicationDatabase, actor: Actor) {
  const attempts = (await database.query<UsageRow>("SELECT id,execution_id,status,cost_configured,reserved_micro_usd,charged_micro_usd,input_tokens,output_tokens,usage_verified,external_state,error_code FROM ai_usage_attempts WHERE actor_id=$1 ORDER BY created_at,id", [actor.userId])).rows;
  const jobs = (await database.query<JobRow>("SELECT id,kind,status,external_state,error_code FROM ai_execution_jobs WHERE actor_id=$1 ORDER BY created_at,id", [actor.userId])).rows;
  const buckets = (await database.query<BucketRow>("SELECT calls,reserved_micro_usd,charged_micro_usd FROM ai_budget_buckets WHERE project_id=$1 ORDER BY period", [`navigator-user:${actor.userId}`])).rows;
  const cards = (await database.query("SELECT id FROM recruiting_cards WHERE user_id=$1 AND status='published'", [actor.userId])).rowCount;
  return { attempts, jobs, buckets, cards };
}

async function verify(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--run" && args[0] !== "--dry-run")) throw new Error("Invalid verification arguments");
  const execute = args[0] === "--run";
  verificationStage = "load_config";
  // Do not cause loadConfig to create an application secret. No website secret
  // is needed for these direct trusted service calls in a disposable database.
  const previousPepper = process.env.AUTH_CODE_PEPPER;
  process.env.AUTH_CODE_PEPPER = "completion-dsh-isolated-verification-only-pepper";
  let actual: Awaited<ReturnType<typeof loadConfig>>;
  try { actual = await loadConfig(); }
  finally { if (previousPepper === undefined) delete process.env.AUTH_CODE_PEPPER; else process.env.AUTH_CODE_PEPPER = previousPepper; }
  if (!actual.dsh) throw new Error("DSH is not configured");
  const configuredBudget = actual.dsh.budget;
  assert.ok(Number(configuredBudget.inputMicroUsdPerMillion) > 0 && Number(configuredBudget.outputMicroUsdPerMillion) > 0, "Positive conservative DSH rates are required");
  const maxInputBytes = Math.min(actual.dsh.maxInputBytes ?? INPUT_LIMIT_BYTES, INPUT_LIMIT_BYTES);
  const maxTokens = Math.min(actual.dsh.maxTokens ?? OUTPUT_LIMIT_TOKENS, OUTPUT_LIMIT_TOKENS);
  assert.ok(maxTokens >= OUTPUT_LIMIT_TOKENS, "The existing DSH token cap must allow the feasibility request");
  const budgetMicroUsd = Math.min(configuredBudget.dailyProjectBudgetMicroUsd ?? BUDGET_LIMIT_MICRO_USD, BUDGET_LIMIT_MICRO_USD);
  const database = await createDatabase({});
  const outcomes: Outcome[] = [];
  let invocations = 0;
  try {
    verificationStage = "isolated_application_setup";
    // Supplying this fresh database, clearing every DB path and removing all
    // unrelated transports prevent touching production or starting a worker.
    const app = await createApplication({ ...actual, mode: "local", origin: "http://localhost:3000", databaseUrl: undefined, localDatabasePath: undefined,
      codePepper: "completion-dsh-isolated-verification-only-pepper", ai: undefined, aiProvider: "dsh",
      smtp: undefined, resendKey: undefined, emailProvider: undefined, github: undefined, authProxySigners: undefined, sourceProxyUrl: undefined,
      discovery: undefined, inspiration: undefined,
      dsh: { ...actual.dsh, maxInputBytes, maxTokens, maxJsonOutputBytes: Math.min(actual.dsh.maxJsonOutputBytes ?? 32_768, 32_768), timeoutMs: Math.min(actual.dsh.timeoutMs ?? TIMEOUT_LIMIT_MS, TIMEOUT_LIMIT_MS),
        budget: { ...configuredBudget, dailyProjectCallLimit: REQUEST_LIMIT, dailyProjectBudgetMicroUsd: budgetMicroUsd } },
    }, database);
    verificationStage = "fictional_fixture_setup";
    const actor: Actor = { userId: `isolated-completion-${randomUUID()}`, platformRoles: ["user"] };
    const another: Actor = { userId: `isolated-other-${randomUUID()}`, platformRoles: ["user"] };
    const now = app.clock.now().toISOString();
    for (const person of [actor, another]) await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES($1,$2,$3,'Asia/Shanghai',ARRAY['user'],$4,$4)", [person.userId, `${person.userId}@example.test`, person === actor ? "小林（虚构隔离测试）" : "另一个虚构测试账号", now]);
    const project = await app.projects.createProject(actor, { name: "AI 黑客松选题验证（虚构隔离测试）", goal: "用用户粘贴的公开比赛要求生成一份易读清单。仅作为验收测试题目，不代表已报名真实比赛。", minimumDeliverable: "单页面输入一段规则文字，展示原文、手动整理字段和待确认事项；先用固定示例演示，再验证真实模型。", timezone: "Asia/Shanghai" });
    await app.participantProfiles.update(actor, { expectedRevision: 0, firstHackathon: true, developmentExperience: "beginner", city: "杭州", skills: ["HTML", "CSS"], interests: ["AI 应用", "界面设计"], projectIdea: "把一段比赛要求整理成清楚的卡片", availableHoursPerDay: 2, travelPreference: "undecided", presentationExperience: "none" });
    const profile = await app.recruiting.saveProfile(actor, { expectedRevision: 0, profile: { primaryRoles: ["frontend"], supportingRoles: ["testing"], purposes: ["learn", "build"], purposeNote: "虚构测试资料：先完成一个小作品，练习解释自己的界面。", resume: "虚构测试经历：刚学过 HTML 和 CSS，可做静态页面；尚未独立接入 AI API，愿意与队友讨论后完成输入和结果展示。", workLinks: [], mbti: "", age: null } });
    const context = await app.teamAssistant.getContext(actor, project.id);
    const initial = await state(database, actor);
    assert.equal(initial.attempts.length, 0); assert.equal(initial.jobs.length, 0); assert.equal(initial.buckets.reduce((sum, bucket) => sum + bucket.calls, 0), 0);
    assert.equal(initial.cards, 0); assert.equal((await app.teamCollaboration.listSharedContext(actor, project.id)).length, 0);
    emit({ phase: "ready", isolatedDatabase: true, mode: execute ? "real" : "dry_run", provider: "dsh", modelRequests: 0,
      testLimits: { requests: REQUEST_LIMIT, budgetMicroUsd, maxInputBytes, maxOutputTokens: maxTokens, timeoutMs: Math.min(actual.dsh.timeoutMs ?? TIMEOUT_LIMIT_MS, TIMEOUT_LIMIT_MS), automaticRetries: 0 }, publicCards: 0, sharedSuggestions: 0 });
    if (!execute) return;

    const originalGenerate = app.personalWorkspace.generate.bind(app.personalWorkspace);
    app.personalWorkspace.generate = (person, request, guard) => {
      assert.equal(person.userId, actor.userId); assert.ok(["profile_summary", "project_feasibility"].includes(request.kind));
      invocations++; assert.ok(invocations <= REQUEST_LIMIT, "No third model invocation is authorized");
      return originalGenerate(person, request, guard);
    };
    // One call per feature. Any invalid/unknown response is recorded and never
    // repaired through a hidden retry, a fixture output or a static fallback.
    try {
      verificationStage = "profile_summary_once";
      const preview = await app.recruiting.generateSummary(actor, { expectedRevision: profile.profile.revision });
      assert.equal(preview.provider, "dsh"); assert.ok(preview.draft.headline.length > 0); assert.ok(preview.draft.introduction.length > 0);
      assert.equal(preview.draft.showAge, false); assert.equal(preview.draft.showMbti, false); assert.equal(preview.draft.showAvatar, false);
      assert.equal(preview.draft.city, "杭州"); assert.equal(preview.draft.availableHoursPerDay, 2);
      const saved = await app.personalWorkspace.get(actor, preview.id); assert.equal(saved.kind, "profile_summary"); assert.deepEqual(saved.data, preview.draft);
      await assert.rejects(app.personalWorkspace.get(another, preview.id), failure => isDomainError(failure) && failure.code === "ARTIFACT_NOT_FOUND");
      const own = await app.recruiting.getProfile(actor); assert.equal(own.card.status, "private"); assert.equal(own.profile.revision, profile.profile.revision);
      outcomes.push({ kind: "profile_summary", outcome: "saved", code: null, provider: "dsh", artifactBytes: Buffer.byteLength(JSON.stringify(saved.data)), characters: preview.draft.headline.length + preview.draft.introduction.length });
    } catch (failure) { outcomes.push({ kind: "profile_summary", outcome: "failed", code: safeCode(failure) }); }
    const afterProfile = await state(database, actor);
    assert.ok(afterProfile.attempts.length <= 1); assert.equal(afterProfile.cards, 0);
    emit({ phase: "profile_summary", ...outcomes[0], budgetReservations: afterProfile.attempts.length, unknownHolds: afterProfile.jobs.filter(job => job.status === "unknown").length, automaticRetries: 0 });

    try {
      verificationStage = "project_feasibility_once";
      const report = await app.teamAssistant.generateFeasibility(actor, project.id, { expectedContextFingerprint: context.fingerprint,
        idea: "虚构隔离验收选题：在 24 小时 AI 黑客松里做一个比赛规则清单网页。用户粘贴公开规则，先用 HTML/CSS 和固定示例做输入、结果与待确认标记；后续由会接口的队友接 AI。团队、主办方规则、真实比赛时间和预算均尚未确认，请把这些写成未知事项。最小验证是两位新人能看懂三条示例要求，不做登录、自动爬取或全网搜索。" });
      assert.equal(report.provider, "dsh"); assert.equal(report.data.projectId, project.id); assert.equal(report.data.contextFingerprint, context.fingerprint);
      assert.equal(report.stale, false); assert.ok(report.data.report.summary.length > 0); assert.ok(report.data.report.validationTasks.length > 0); assert.ok(report.data.report.unknowns.length > 0);
      const saved = await app.personalWorkspace.get(actor, report.id); assert.equal(saved.kind, "project_feasibility"); assert.deepEqual(saved.data, report.data);
      const listed = await app.teamAssistant.listFeasibility(actor, project.id); assert.ok(listed.some(item => item.id === report.id && !item.stale));
      await assert.rejects(app.personalWorkspace.get(another, report.id), failure => isDomainError(failure) && failure.code === "ARTIFACT_NOT_FOUND");
      const findings = report.data.report.ruleFit.length + report.data.report.technicalChecks.length + report.data.report.teamAndTime.length + report.data.report.risks.length;
      outcomes.push({ kind: "project_feasibility", outcome: "saved", code: null, provider: "dsh", artifactBytes: Buffer.byteLength(JSON.stringify(saved.data)), characters: report.data.report.summary.length, findings, validationTasks: report.data.report.validationTasks.length });
    } catch (failure) { outcomes.push({ kind: "project_feasibility", outcome: "failed", code: safeCode(failure) }); }

    verificationStage = "final_accounting_and_privacy_checks";
    const final = await state(database, actor);
    assert.equal(invocations, REQUEST_LIMIT); assert.ok(final.attempts.length <= REQUEST_LIMIT);
    assert.ok(final.jobs.every(job => job.kind === "personal_artifact" && ["succeeded", "failed", "unknown"].includes(job.status)));
    assert.equal(final.cards, 0); assert.equal((await app.teamCollaboration.listSharedContext(actor, project.id)).length, 0);
    for (const attempt of final.attempts) {
      assert.equal(attempt.status, "settled", "No accounting reservation may be silently discarded"); assert.equal(attempt.cost_configured, true);
      if (["unknown", "response_received"].includes(attempt.external_state) && !attempt.usage_verified) assert.equal(Number(attempt.charged_micro_usd), Number(attempt.reserved_micro_usd), "Unknown/unmeasured request must charge the full reserve");
      if (attempt.usage_verified) assert.ok(Number(attempt.input_tokens) >= 0 && Number(attempt.output_tokens) >= 0 && Number(attempt.charged_micro_usd) >= 0);
      if (attempt.external_state === "unknown") assert.ok(final.jobs.some(job => job.id === attempt.execution_id && job.status === "unknown"), "Unknown request needs an unreplayable execution hold");
    }
    const calls = final.buckets.reduce((sum, bucket) => sum + bucket.calls, 0);
    const reserved = final.buckets.reduce((sum, bucket) => sum + Number(bucket.reserved_micro_usd), 0);
    const charged = final.buckets.reduce((sum, bucket) => sum + Number(bucket.charged_micro_usd), 0);
    assert.equal(calls, final.attempts.length); assert.equal(reserved, 0);
    assert.equal(charged, final.attempts.reduce((sum, attempt) => sum + Number(attempt.charged_micro_usd), 0));
    const artifacts = (await database.query<{ kind: PersonalArtifactKind }>("SELECT kind FROM personal_ai_artifacts WHERE user_id=$1 ORDER BY kind", [actor.userId])).rows;
    emit({ phase: "complete", isolatedDatabase: true, provider: "dsh", outcome: outcomes.every(item => item.outcome === "saved") ? "passed" : "failed",
      serviceInvocations: invocations, modelRequests: final.attempts.filter(attempt => attempt.external_state !== "not_sent").length, budgetReservations: final.attempts.length,
      usageVerified: final.attempts.filter(attempt => attempt.usage_verified).length, unknownHolds: final.jobs.filter(job => job.status === "unknown").length,
      chargedMicroUsd: charged, remainingReservedMicroUsd: reserved, artifactKinds: artifacts.map(item => item.kind), outcomes,
      publicCards: 0, sharedSuggestions: 0, automaticallyShared: false, automaticRetries: 0 });
    if (outcomes.some(item => item.outcome === "failed")) process.exitCode = 1;
  } finally { await database.close(); }
}

try { await verify(); }
catch (failure) { emit({ phase: "aborted", stage: verificationStage, outcome: "failed", code: safeCode(failure), automaticRetries: 0 }); process.exitCode = 1; }
