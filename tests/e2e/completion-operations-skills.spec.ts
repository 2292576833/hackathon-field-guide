import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { AGENT_IDS, INITIAL_SKILLS, hash } from "../../src/modules/skills/index.ts";
import type { ProjectSkillSelectionView, ReviewedSkillOption, SkillCandidateDocument, SkillCandidateEvidence, SkillReviewSnapshot, TaskSkillReference } from "../../src/modules/skills/index.ts";
import type { Project } from "../../src/modules/projects/index.ts";
import type { SkillReview } from "../../src/modules/operations/skill-review.ts";
import type { AuditQueryPage } from "../../src/modules/operations/audit-query-types.ts";
import type { SourceConfig, SourceDraft } from "../../src/modules/operations/source-domain.ts";
import type { SourceObservabilityReport } from "../../src/modules/operations/observability-types.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

test.use({ trace: "off", video: "off", screenshot: "off" });

async function administrator(f: IsolatedWorkspace, email: string) {
  const identity = await f.login(email, "隔离验收管理员");
  // Only this test's fresh, owned PGlite instance is changed; no production account.
  await f.database.query("UPDATE auth_users SET platform_roles=ARRAY['user','admin']::text[],revision=revision+1 WHERE id=$1", [identity.userId]);
  return identity;
}
async function space(f: IsolatedWorkspace, owner: FixtureIdentity, name: string) {
  return f.request<Project>("projects", "POST", { name, timezone: "Asia/Shanghai", goal: "完成一条可体验的参赛流程", minimumDeliverable: "一个能演示的原型" }, owner, 201);
}
async function join(f: IsolatedWorkspace, projectId: string, owner: FixtureIdentity, member: FixtureIdentity) {
  const current = await f.request<{ project: Project }>(`projects/${projectId}`, "GET", undefined, owner);
  const invitation = await f.request<{ token: string }>(`projects/${projectId}/invitations`, "POST", { expectedRevision: current.project.revision, role: "member", maxUses: 1 }, owner, 201);
  await f.request(`invitations/${invitation.token}/accept`, "POST", {}, member);
}
async function archive(f: IsolatedWorkspace, projectId: string, owner: FixtureIdentity) {
  const current = await f.request<{ project: Project }>(`projects/${projectId}`, "GET", undefined, owner);
  await f.request(`projects/${projectId}/stage`, "POST", { expectedRevision: current.project.revision, stage: "archived", reason: "隔离验收归档只读规则" }, owner);
}
const candidatePath = (target: { kind: string; id: string; versionId: string }) => `admin/skill-candidates/${[target.kind, target.id, target.versionId].map(encodeURIComponent).join("/")}`;
const expectations = (candidate: SkillReviewSnapshot) => ({ expectedCandidateRevision: candidate.revision, expectedContentHash: candidate.contentHash, expectedManifestHash: candidate.manifestHash });
const choiceValue = (option: ReviewedSkillOption) => `${option.reference.kind}:${option.reference.versionId}:${option.reference.contentHash}:${option.reference.revision}`;

/** This is explicitly unverified fixture content, never an external-file check. */
function unknownCandidate() {
  const skill = structuredClone(INITIAL_SKILLS.find(item => item.id === "create-readme")!);
  const version = skill.versions[0], originalCommit = version.commit;
  version.commit = "a".repeat(40); version.id = `${skill.id}@${version.commit}`; version.version = "isolated-unknown";
  version.files = version.files.map(file => ({ ...file, downloadUrl: file.downloadUrl.replace(originalCommit, version.commit) }));
  version.contentHash = hash(version.files);
  version.license.sourceUrl = version.files.find(file => file.relativePath === version.license.filePath)!.downloadUrl;
  skill.sourceUrl = `https://github.com/${version.repository}/tree/${version.commit}/${version.skillPath}`;
  const document: SkillCandidateDocument = { kind: "skill", skill };
  const evidence: SkillCandidateEvidence = {
    license: { status: "unknown", sourceUrl: null, sha256: null, checkedBy: null, checkedAt: null, noticesIncluded: false },
    behavior: { status: "unknown", checkedBy: null, checkedAt: null, note: "隔离夹具：没有下载、核验或运行第三方文件。" },
    compatibility: [],
  };
  return { expectedRevision: 0, document, evidence };
}
function sourceDraft(owner: FixtureIdentity): SourceDraft {
  return { name: "隔离来源：只登记、尚未采集", ownerUserId: owner.userId, type: "official_event", acquisitionMethod: "restricted_http", sampleUrl: "https://ethglobal.com/events/", minimumIntervalSeconds: 3600,
    networkPolicy: { version: 1, rules: [{ hostname: "ethglobal.com", pathPrefix: "/events/" }], maxRedirects: 0, maxBytes: 65536, timeoutMs: 1000, acceptedContentTypes: ["text/html"] } };
}
async function error(f: IsolatedWorkspace, path: string, method: string, body: unknown, actor: FixtureIdentity | undefined, status: number, code?: string) {
  const response = await f.raw(path, method, body, actor);
  const envelope = await response.json() as { error?: { code: string } };
  expect(response.status, `Rejected fixture response: ${envelope.error?.code}`).toBe(status);
  if (code) expect(envelope.error?.code).toBe(code);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Whole page must fit the selected viewport").toBe(true);
}
function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", err => errors.push(err.message));
  return errors;
}
async function noExternalWork(f: IsolatedWorkspace) {
  expect(f.externalRequests).toEqual([]);
  for (const table of ["ai_usage_attempts", "ai_execution_jobs", "ai_budget_buckets", "resource_link_maintenance_state", "resource_link_check_results", "resource_link_maintenance_sites"]) {
    expect((await f.database.query(`SELECT * FROM ${table}`)).rows, `${table} must remain unchanged by status/catalog reads`).toEqual([]);
  }
  expect(f.apiReads.filter(item => /^(POST|PUT|PATCH|DELETE) (skills\/installation|skill-bundles\/installation|admin\/sources\/[^/]+\/crawl|admin\/execution-runs)/.test(item))).toEqual([]);
}

test("API: actual review publication guards, project skills permissions, bounded metadata queries and maintenance reads have no external work", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const admin = await administrator(f, "ops-api-admin@example.test"), owner = await f.login("ops-api-owner@example.test", "隔离队长"), member = await f.login("ops-api-member@example.test", "隔离成员"), outsider = await f.login("ops-api-outsider@example.test", "其他账号");
    expect((await f.request<AuditQueryPage>("admin/operations/audit", "GET", undefined, admin)).items).toEqual([]);
    const candidate = await f.request<SkillReviewSnapshot>("admin/skill-candidates", "POST", unknownCandidate(), admin);
    const detail = await f.request<SkillReviewSnapshot>(candidatePath(candidate), "GET", undefined, admin);
    expect(detail.document).toEqual(candidate.document); expect(detail.validationErrors.length).toBeGreaterThan(0);
    const review = await f.request<SkillReview>(`${candidatePath(candidate)}/reviews`, "POST", expectations(candidate), admin, 201);
    expect(review.status).toBe("pending");
    const replay = await f.request<SkillReview>(`${candidatePath(candidate)}/reviews`, "POST", expectations(candidate), admin, 201);
    expect(replay.reviewId).toBe(review.reviewId);
    await error(f, `admin/skill-reviews/${review.reviewId}/decide`, "POST", { ...expectations(candidate), expectedRevision: review.revision, decision: "approved", reason: "隔离校验：不能批准未知证据", verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: [...AGENT_IDS] } }, admin, 422, "SKILL_INVALID");
    await error(f, `admin/skill-reviews/${review.reviewId}/publish`, "POST", { ...expectations(candidate), expectedRevision: review.revision }, admin, 409, "REVIEW_NOT_APPROVED");
    await error(f, candidatePath(candidate), "GET", undefined, outsider, 403);
    expect((await f.request<SkillReview[]>(`admin/skill-reviews?${new URLSearchParams({ kind: candidate.kind, id: candidate.id, versionId: candidate.versionId, limit: "100" })}`, "GET", undefined, admin)).map(item => item.reviewId)).toEqual([review.reviewId]);
    expect((await f.request<SkillReviewSnapshot>(candidatePath(candidate), "GET", undefined, admin)).state).toBe("draft");

    // Positive publication uses explicitly prepared verification fixture facts,
    // not a claim that this test downloaded or checked any upstream files.
    const prepared = structuredClone(unknownCandidate());
    if (prepared.document.kind !== "skill") throw new Error("Expected isolated skill fixture");
    const fixed = prepared.document.skill.versions[0], checkedAt = f.app.clock.now().toISOString();
    prepared.evidence = { license: { status: "verified", sourceUrl: fixed.license.sourceUrl, sha256: fixed.license.sha256, checkedBy: admin.userId, checkedAt, noticesIncluded: true },
      behavior: { status: "reviewed", checkedBy: admin.userId, checkedAt, note: "显式审核夹具：验证发布流程；没有执行真实文件检查。" }, compatibility: [] };
    prepared.expectedRevision = candidate.revision;
    await f.request("admin/skill-candidates", "POST", prepared, admin);
    const preparedSnapshot = await f.request<SkillReviewSnapshot>(candidatePath(candidate), "GET", undefined, admin);
    expect(preparedSnapshot.validationErrors).toEqual([]);
    await error(f, `admin/skill-reviews/${review.reviewId}/decide`, "POST", { ...expectations(candidate), expectedRevision: review.revision, decision: "approved", reason: "旧审核不能批准新修订", verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: [...AGENT_IDS] } }, admin, 409, "VERSION_CONFLICT");
    const nextReview = await f.request<SkillReview>(`${candidatePath(candidate)}/reviews`, "POST", expectations(preparedSnapshot), admin, 201);
    const approved = await f.request<SkillReview>(`admin/skill-reviews/${nextReview.reviewId}/decide`, "POST", { ...expectations(preparedSnapshot), expectedRevision: nextReview.revision, decision: "approved", reason: "显式夹具：许可与行为有已准备记录，兼容仍未知", verification: { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: [...AGENT_IDS] } }, admin);
    const published = await f.request<SkillReview>(`admin/skill-reviews/${approved.reviewId}/publish`, "POST", { ...expectations(preparedSnapshot), expectedRevision: approved.revision }, admin);
    expect(published.status).toBe("published"); expect(published.evidence.compatibility).toEqual([]);
    expect((await f.request<SkillReviewSnapshot>(candidatePath(candidate), "GET", undefined, admin)).state).toBe("published");

    const source = await f.request<SourceConfig>("admin/sources", "POST", sourceDraft(admin), admin, 201);
    const audit = await f.request<AuditQueryPage>(`admin/operations/audit?${new URLSearchParams({ actorId: admin.userId, objectKind: "source", objectId: source.id, action: "SourceProposed", limit: "50" })}`, "GET", undefined, admin);
    expect(audit.items).toHaveLength(1); expect(audit.items[0]).toMatchObject({ objectId: source.id, action: "SourceProposed", revision: 1 });
    expect(JSON.stringify(audit)).not.toContain(admin.email); expect(JSON.stringify(audit)).not.toContain(source.sampleUrl);
    expect(Object.keys(audit.items[0]).sort()).toEqual(["action", "actorId", "actorKind", "contentVersion", "id", "objectId", "objectKind", "occurredAt", "revision", "stream"].sort());
    const report = await f.request<SourceObservabilityReport>(`admin/sources/${source.id}/observability?limit=50`, "GET", undefined, admin);
    expect(report.runs).toEqual([]); expect(report.failures).toEqual([]); expect(report.counts).toEqual([]);
    expect(report.runtime).toMatchObject({ worker: { scope: "all_sources", status: "not_started" }, model: { calls: 0, admission: "not_configured", completeCostMicroUsd: null } });
    expect(JSON.stringify(report)).not.toContain(source.sampleUrl); expect(JSON.stringify(report)).not.toContain(admin.userId);
    await error(f, `admin/sources/${source.id}/observability?limit=101`, "GET", undefined, admin, 422);
    await error(f, "admin/operations/audit?limit=101", "GET", undefined, admin, 400, "INVALID_AUDIT_QUERY");
    const now = f.app.clock.now(), earlier = new Date(now.getTime() - 32 * 86400000);
    await error(f, `admin/operations/audit?${new URLSearchParams({ from: earlier.toISOString(), to: now.toISOString() })}`, "GET", undefined, admin, 400, "INVALID_AUDIT_QUERY");
    await error(f, `admin/sources/${source.id}/observability?${new URLSearchParams({ since: earlier.toISOString(), until: now.toISOString() })}`, "GET", undefined, admin, 422);
    for (const path of ["admin/operations/audit", `admin/sources/${source.id}/observability`, "admin/resources/link-checks", "admin/operations/retention"]) await error(f, path, "GET", undefined, outsider, 403);
    for (let round = 0; round < 2; round++) { await f.request("admin/resources/link-checks", "GET", undefined, admin); await f.request("admin/operations/retention", "GET", undefined, admin); }

    const first = await space(f, owner, "隔离技能来源空间"), second = await space(f, owner, "隔离技能目标空间"); await join(f, first.id, owner, member);
    const catalog = await f.request<{ items: ReviewedSkillOption[] }>(`projects/${first.id}/skills/catalog`, "GET", undefined, owner);
    const option = catalog.items.find(item => item.reference.kind === "skill" && item.reference.id === "create-readme")!; expect(option).toBeTruthy();
    const selection: TaskSkillReference = { reference: option.reference, purpose: "为演示原型写清运行方法", learningMinutes: 35, environment: { agentId: "codex", os: "Windows 11" } };
    const saved = await f.request<ProjectSkillSelectionView>(`projects/${first.id}/skills`, "PUT", { expectedRevision: 0, selections: [selection] }, owner);
    expect(saved.selections).toEqual([selection]);
    expect((await f.request<ProjectSkillSelectionView>(`projects/${first.id}/skills`, "GET", undefined, member)).selections).toEqual([selection]);
    await error(f, `projects/${first.id}/skills`, "PUT", { expectedRevision: saved.revision, selections: [] }, member, 403);
    await error(f, `projects/${first.id}/skills`, "GET", undefined, outsider, 403);
    await f.request(`projects/${second.id}/skills/copy`, "POST", { sourceProjectId: first.id, expectedRevision: 0 }, owner);
    expect((await f.request<ProjectSkillSelectionView>(`projects/${second.id}/skills`, "GET", undefined, owner)).selections).toEqual([selection]);
    await archive(f, second.id, owner);
    const archived = await f.request<ProjectSkillSelectionView>(`projects/${second.id}/skills`, "GET", undefined, owner);
    expect(archived).toMatchObject({ readOnly: true, canManage: false });
    await error(f, `projects/${second.id}/skills`, "PUT", { expectedRevision: archived.revision, selections: [] }, owner, 409);
    await error(f, `projects/${second.id}/skills/copy`, "POST", { sourceProjectId: first.id, expectedRevision: archived.revision }, owner, 409);
    await noExternalWork(f);
  } finally { await f.close(); }
});

test("admin desktop and 375px: full skill candidate review, explicit unknown evidence and bounded read-only operations status", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const admin = await administrator(f, "ops-browser-admin@example.test"), candidate = await f.request<SkillReviewSnapshot>("admin/skill-candidates", "POST", unknownCandidate(), admin), page = await f.page(admin, 1280), errors = captureErrors(page);
    page.setDefaultTimeout(15_000); await page.goto("/admin");
    const nav = page.getByRole("navigation", { name: "运营模块", exact: true });
    await nav.getByRole("button", { name: "技能审核", exact: true }).click();
    const panel = page.getByRole("region", { name: "技能版本审核与发布", exact: true });
    await panel.getByRole("combobox", { name: "选择精确版本", exact: true }).selectOption(JSON.stringify([candidate.kind, candidate.id, candidate.versionId]));
    const snapshot = panel.getByRole("region", { name: "当前服务器快照", exact: true });
    await expect(snapshot).toContainText(candidate.manifestHash);
    const editor = panel.getByRole("region", { name: "候选内容编辑", exact: true });
    // PostgreSQL JSONB legitimately reorders keys; compare complete structures.
    await expect.poll(async () => JSON.parse(await editor.getByRole("textbox", { name: "候选内容 JSON", exact: true }).inputValue())).toEqual(candidate.document);
    await expect.poll(async () => JSON.parse(await editor.getByRole("textbox", { name: "审核证据 JSON", exact: true }).inputValue())).toEqual(candidate.evidence);
    await panel.getByText(/^固定来源与文件清单（/).click();
    await expect(panel).toContainText("a".repeat(40)); await expect(panel).toContainText("许可核验：未知"); await expect(panel).toContainText("行为核验：未知");
    await panel.getByRole("button", { name: "登记当前快照审核", exact: true }).click();
    await expect(panel).toContainText("已登记当前精确版本的审核。");
    await panel.getByRole("textbox", { name: "审核 / 撤回说明", exact: true }).fill("隔离验收：保留未知，等待人工核验");
    for (const name of ["我已核对许可来源、哈希及必要声明。", "我已审阅此固定版本的文件行为、权限和依赖说明。"]) await panel.getByRole("checkbox", { name, exact: true }).check();
    await panel.getByRole("checkbox", { name: /^我已核对以下工具的本站示例任务验证缺项：/ }).check();
    await expect(panel.getByRole("button", { name: "审核通过", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "发布已批准的精确版本", exact: true })).toBeDisabled();
    expect(f.apiReads.some(item => item.startsWith("POST admin/skill-candidates/") && item.endsWith("/reviews"))).toBe(true);
    await noOverflow(page); await page.setViewportSize({ width: 375, height: 900 }); await noOverflow(page);
    const seedCandidates = await f.request<SkillReviewSnapshot[]>("admin/skill-candidates", "GET", undefined, admin);
    const legacy = seedCandidates.find(item => item.kind === "skill" && item.id === "agent-architecture" && item.state === "published")!;
    await panel.getByRole("combobox", { name: "选择精确版本", exact: true }).selectOption(JSON.stringify([legacy.kind, legacy.id, legacy.versionId]));
    await expect(panel.getByRole("table")).toContainText("安装器声明");
    await expect(panel.getByRole("table")).toContainText("cline"); await noOverflow(page);
    await nav.getByRole("button", { name: "操作记录", exact: true }).click();
    const audit = page.getByRole("region", { name: "运营审计", exact: true });
    await expect(audit).toContainText("这个时间窗口和筛选条件下没有记录。");
    const source = await f.request<SourceConfig>("admin/sources", "POST", sourceDraft(admin), admin, 201);
    await audit.getByRole("textbox", { name: "操作者标识", exact: true }).fill(admin.userId);
    await audit.getByRole("combobox", { name: "对象类型", exact: true }).selectOption("source");
    await audit.getByRole("textbox", { name: "对象标识", exact: true }).fill(source.id);
    await audit.getByRole("button", { name: "查询记录", exact: true }).click();
    await expect(audit.getByRole("table")).toContainText("登记来源"); await expect(audit.getByRole("table")).toContainText(source.id);
    await expect(audit).not.toContainText(admin.email); await expect(audit).not.toContainText(source.sampleUrl);
    await expect(audit.getByRole("button", { name: "下一页", exact: true })).toBeDisabled(); await noOverflow(page);
    await nav.getByRole("button", { name: "来源与运行", exact: true }).click();
    await page.getByRole("button", { name: "配置、验证与采集", exact: true }).click();
    const observation = page.getByRole("region", { name: "单来源故障归因", exact: true });
    await expect(observation).toContainText("这个时间窗口内没有任务。");
    await expect(observation).toContainText("这个时间窗口内没有已记录的失败。");
    await expect(observation).toContainText("尚未启动"); await expect(observation).toContainText("尚未配置"); await expect(observation).toContainText("费用结算不完整。");
    await observation.getByRole("button", { name: "重新查询", exact: true }).click();
    const maintenance = page.getByRole("region", { name: "资源入口维护", exact: true });
    await expect(maintenance).toContainText("还没有当前审核版本的检查记录。");
    await maintenance.getByRole("button", { name: "刷新检查记录", exact: true }).click();
    await expect(maintenance).toContainText("后台尚未开始这项维护。");
    await noOverflow(page); await page.setViewportSize({ width: 1280, height: 900 }); await noOverflow(page);
    expect(errors).toEqual([]); await noExternalWork(f);
  } finally { await f.close(); }
});

async function openSkills(page: Page, projectId: string): Promise<Locator> {
  await page.goto(`/app/projects/${projectId}/resources`);
  await page.getByText("本次项目的技能与技能包（可选）", { exact: true }).click();
  const panel = page.getByRole("region", { name: "项目技能选择", exact: true });
  await expect(panel).toBeVisible(); return panel;
}

test("project skills 375px and desktop: optional catalog selection, save, copy, withdrawal history, archived read-only and account isolation", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("skill-browser-owner@example.test", "隔离技能队长"), admin = await administrator(f, "skill-browser-admin@example.test"), outsider = await f.login("skill-browser-outsider@example.test", "没有空间权限的账号");
    const first = await space(f, owner, "隔离：技能来源空间"), second = await space(f, owner, "隔离：技能目标空间");
    const page = await f.page(owner, 375), errors = captureErrors(page);
    page.setDefaultTimeout(15_000); await page.goto(`/app/projects/${first.id}/resources`);
    const summary = page.getByText("本次项目的技能与技能包（可选）", { exact: true });
    await expect(summary).toBeVisible(); await expect(page.getByRole("region", { name: "项目技能选择", exact: true })).not.toBeVisible();
    await summary.click(); const panel = page.getByRole("region", { name: "项目技能选择", exact: true });
    const catalog = await f.request<{ items: ReviewedSkillOption[] }>(`projects/${first.id}/skills/catalog`, "GET", undefined, owner);
    const option = catalog.items.find(item => item.reference.kind === "skill" && item.reference.id === "create-readme")!;
    await panel.getByRole("combobox", { name: "已审核的固定版本", exact: true }).selectOption(choiceValue(option));
    await panel.getByRole("textbox", { name: "用在哪项工作、帮助完成什么", exact: true }).fill("隔离保存用途：让队友能运行演示原型");
    await panel.getByRole("spinbutton", { name: "学习、配置和试用估算（分钟）", exact: true }).fill("35");
    await panel.getByRole("combobox", { name: "计划使用的 AI 工具", exact: true }).selectOption("codex");
    await panel.getByRole("textbox", { name: "操作系统（选填）", exact: true }).fill("Windows 11");
    await expect(panel).toContainText("客户端加载与示例任务待验证");
    await panel.getByRole("button", { name: "加入选择", exact: true }).click();
    await expect(panel).toContainText("已加入本地选择，保存后团队可见。");
    expect((await f.request<ProjectSkillSelectionView>(`projects/${first.id}/skills`, "GET", undefined, owner)).selections).toEqual([]);
    await panel.getByRole("button", { name: "保存团队技能选择", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("固定版本与用途已保存");
    const saved = await f.request<ProjectSkillSelectionView>(`projects/${first.id}/skills`, "GET", undefined, owner);
    expect(saved.selections).toHaveLength(1); expect(saved.selections[0]).toMatchObject({ reference: option.reference, learningMinutes: 35, environment: { agentId: "codex", os: "Windows 11" } });
    await noOverflow(page);
    await openSkills(page, second.id);
    await page.getByText("从其他参赛空间复用技能选择", { exact: true }).click();
    await page.getByRole("combobox", { name: "选择你可访问的来源空间", exact: true }).selectOption(first.id);
    await page.getByRole("button", { name: "复制并替换本空间技能选择", exact: true }).click();
    await expect(page.getByRole("region", { name: "空间技能与技能包", exact: true })).toContainText("没有安装任何技能。");
    expect((await f.request<ProjectSkillSelectionView>(`projects/${second.id}/skills`, "GET", undefined, owner)).selections).toEqual(saved.selections);
    const candidate = await f.request<SkillReviewSnapshot>(candidatePath(option.reference), "GET", undefined, admin);
    await f.request(`${candidatePath(candidate)}/withdraw`, "POST", { ...expectations(candidate), operationId: randomUUID(), reason: "隔离撤回：验证旧引用提示，不修改真实目录" }, admin);
    const target = page.getByRole("region", { name: "项目技能选择", exact: true });
    await target.getByRole("button", { name: "刷新已审核目录", exact: true }).click();
    await expect(target).toContainText("历史选择保留，未自动升级。");
    expect((await f.request<ProjectSkillSelectionView>(`projects/${second.id}/skills`, "GET", undefined, owner)).selections).toEqual(saved.selections);
    await page.setViewportSize({ width: 1280, height: 900 }); await noOverflow(page);
    await archive(f, second.id, owner); await openSkills(page, second.id);
    await expect(page.getByRole("region", { name: "项目技能选择", exact: true })).toContainText("空间只读，保留历史选择与版本依据。");
    await expect(page.getByRole("button", { name: "保存团队技能选择", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "复制并替换本空间技能选择", exact: true })).toHaveCount(0);
    await noOverflow(page);
    // Swap the live session in the SAME browser context, so existing UI state must
    // be invalidated rather than merely testing two independent page instances.
    const separator = outsider.cookie.indexOf("=");
    await page.context().addCookies([{ name: outsider.cookie.slice(0, separator), value: outsider.cookie.slice(separator + 1), domain: new URL(f.origin).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("region", { name: "项目技能选择", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("隔离保存用途：让队友能运行演示原型");
    await error(f, `projects/${second.id}/skills`, "GET", undefined, outsider, 403);
    expect(errors).toEqual([]); await noExternalWork(f);
  } finally { await f.close(); }
});
