import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { AGENT_IDS, INITIAL_SKILLS, createPostgresSkillsRepository, seedInitialSkills, hash } from "../skills/index.ts";
import { bundleLicenseReviewHash, createSkillCandidateService, createSkillPublicationPort } from "../skills/publication.ts";
import type { SkillCandidate, SkillCandidateDocument, SkillCandidateEvidence, SkillPublicationPort, SkillPublicationTarget, SkillReviewSnapshot } from "../skills/publication-types.ts";
import { SkillReviewService } from "./skill-review-service.ts";
import { PostgresSkillReviewRepository } from "./skill-review-postgres.ts";
import type { SkillReview, SkillReviewDependencies, SkillReviewExpectation, SkillReviewVerification } from "./skill-review-types.ts";

const actor: Actor = { userId: "reviewer", platformRoles: ["reviewer"] };
const user: Actor = { userId: "user", platformRoles: ["user"] };
const now = "2026-10-10T00:00:00.000Z";
const clock = { now: () => new Date(now) };
const verification: SkillReviewVerification = { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: [...AGENT_IDS] };
const isCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
function expectation(candidate: SkillCandidate): SkillReviewExpectation { return { expectedCandidateRevision: candidate.revision, expectedContentHash: candidate.contentHash, expectedManifestHash: candidate.manifestHash }; }
function target(candidate: SkillCandidate): SkillPublicationTarget { return { kind: candidate.kind, id: candidate.id, versionId: candidate.versionId }; }
function candidateDocument(): SkillCandidateDocument {
  const skill = structuredClone(INITIAL_SKILLS[0]!);
  const version = skill.versions[0]!; const commit = "f".repeat(40);
  version.id = `${skill.id}@${commit}`; version.commit = commit;
  version.files = version.files.map(file => ({ ...file, downloadUrl: `https://raw.githubusercontent.com/${version.repository}/${commit}/${file.repositoryPath.split("/").map(encodeURIComponent).join("/")}` }));
  version.contentHash = hash(version.files);
  version.license.sourceUrl = version.files.find(file => file.relativePath === version.license.filePath)!.downloadUrl;
  skill.sourceUrl = `https://github.com/${version.repository}/tree/${commit}/${version.skillPath}`;
  return { kind: "skill", skill };
}
function evidence(document: SkillCandidateDocument): SkillCandidateEvidence {
  assert.equal(document.kind, "skill");
  const version = document.skill.versions[0]!;
  return { license: { status: "verified", sourceUrl: version.license.sourceUrl, sha256: version.license.sha256, checkedBy: actor.userId, checkedAt: now, noticesIncluded: true },
    behavior: { status: "reviewed", checkedBy: actor.userId, checkedAt: now, note: "隔离测试夹具；没有下载或执行第三方文件。" },
    compatibility: version.compatibility.map(entry => ({ agentId: entry.agentId, level: "installer_declared", source: "official_documentation", clientVersion: null, os: null, checkedAt: null, evidenceUrl: entry.evidenceUrl, task: null, limitation: entry.limitation })) };
}
async function setup(options: { skills?: (port: SkillPublicationPort) => SkillPublicationPort; authorize?: SkillReviewDependencies["assertActorCurrent"] } = {}) {
  const pg = new PGlite();
  for (const path of ["../skills/schema.sql", "../skills/candidate-schema.sql", "skill-review.sql"]) await pg.exec(await readFile(new URL(path, import.meta.url), "utf8"));
  const calls: string[] = [];
  const executor = (connection: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }> }): SqlExecutor => ({ async query<Row>(sql: string, parameters?: readonly unknown[]) { calls.push(sql); const value = await connection.query(sql, parameters ? [...parameters] : undefined); return { rows: value.rows as Row[], rowCount: value.affectedRows ?? value.rows.length }; } });
  const database: DatabasePort = { ...executor(pg), transaction: work => pg.transaction(tx => work(executor(tx))) };
  await seedInitialSkills(createPostgresSkillsRepository(database));
  let sequence = 0; const ids = { next: () => `skill-review-test-${++sequence}` };
  const candidates = createSkillCandidateService({ database, clock, ids });
  const repository = new PostgresSkillReviewRepository(database);
  const service = new SkillReviewService({ repository, skills: options.skills?.(createSkillPublicationPort()) ?? createSkillPublicationPort(), clock, ids, assertActorCurrent: options.authorize });
  const document = candidateDocument(); const saved = await candidates.save(actor, { expectedRevision: 0, document, evidence: evidence(document) });
  return { pg, calls, database, ids, candidates, repository, service, document, saved };
}
async function approved(service: SkillReviewService, candidate: SkillCandidate): Promise<SkillReview> {
  const review = await service.register(actor, target(candidate), expectation(candidate), "register");
  return service.decide(actor, review.reviewId, { ...expectation(candidate), expectedRevision: review.revision, decision: "approved", reason: "依据固定版本逐项核查，未知工具限制保留。", verification }, "approve");
}

test("M08 exact review and M10 publication commit together; self review and untested tools stay visible, no installation created", async () => {
  const f = await setup(); try {
    await assert.rejects(f.service.register(user, target(f.saved), expectation(f.saved), "forbidden"), isCode("OPERATIONS_FORBIDDEN"));
    const pending = await f.service.register(actor, target(f.saved), expectation(f.saved), "register");
    const duplicate = await f.service.register(actor, target(f.saved), expectation(f.saved), "register-retry"); assert.equal(pending.reviewId, duplicate.reviewId);
    await assert.rejects(f.service.decide(actor, pending.reviewId, { ...expectation(f.saved), expectedRevision: 1, decision: "approved", reason: "测试", verification: { ...verification, acknowledgedCompatibility: [] } }, "unknown"), isCode("UNKNOWN_NOT_ACKNOWLEDGED"));
    const change = await f.service.decide(actor, pending.reviewId, { ...expectation(f.saved), expectedRevision: 1, decision: "changes_requested", reason: "补齐说明" }, "changes");
    const review = await f.service.decide(actor, pending.reviewId, { ...expectation(f.saved), expectedRevision: change.revision, decision: "approved", reason: "已核验；工具待真实示例任务验证", verification }, "approved");
    const published = await f.service.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision }, "publish");
    const replay = await f.service.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision }, "publish-retry");
    assert.deepEqual(replay, published); assert.equal(published.status, "published");
    const detail = await f.service.getDetail(actor, review.reviewId); assert.equal(detail.candidate.state, "published");
    assert.ok(detail.candidate.evidence.compatibility.every(entry => entry.level === "installer_declared"));
    const audits = (await f.database.query<{ payload: { action: string; selfReviewed: boolean; manifestHash: string } }>("SELECT payload FROM operations_skill_review_audit ORDER BY occurred_at,audit_id")).rows;
    assert.equal(audits.length, 4); assert.equal(audits.find(value => value.payload.action === "skill_approved")?.payload.selfReviewed, true); assert.ok(audits.every(value => value.payload.manifestHash === f.saved.manifestHash));
    assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM skill_installation_plans")).rows[0]?.count, 0);
    assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM skill_installation_receipts")).rows[0]?.count, 0);
  } finally { await f.pg.close(); }
});

test("old review cannot approve or publish edited candidate; exact hash and manifest expected values cannot be skipped", async () => {
  const f = await setup(); try {
    const review = await approved(f.service, f.saved);
    await assert.rejects(f.service.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision, expectedManifestHash: "0".repeat(64) }, "wrong-manifest"), isCode("VERSION_CONFLICT"));
    await assert.rejects(f.service.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision, expectedContentHash: "0".repeat(64) }, "wrong-content"), isCode("VERSION_CONFLICT"));
    const nextDocument = structuredClone(f.document); assert.equal(nextDocument.kind, "skill"); nextDocument.skill.summary += " 修订";
    const next = await f.candidates.save(actor, { expectedRevision: 1, document: nextDocument, evidence: evidence(nextDocument) });
    await assert.rejects(f.service.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision }, "stale-publish"), isCode("VERSION_CONFLICT"));
    const nextReview = await f.service.register(actor, target(next), expectation(next), "next");
    await assert.rejects(f.service.decide(actor, nextReview.reviewId, { ...expectation(f.saved), expectedRevision: 1, decision: "approved", reason: "旧版本", verification }, "stale-approve"), isCode("VERSION_CONFLICT"));
    await assert.rejects(f.service.decide(actor, nextReview.reviewId, { ...expectation(next), expectedRevision: 2, decision: "approved", reason: "审核CAS", verification }, "stale-review"), isCode("VERSION_CONFLICT"));
    assert.equal((await f.service.getDetail(actor, review.reviewId)).candidate.state, "draft");
  } finally { await f.pg.close(); }
});

test("unknown license or unchecked behavior cannot approve; tampered manifest fails before a decision", async () => {
  const f = await setup(); try {
    const unknown = evidence(f.document); unknown.license = { status: "unknown", sourceUrl: null, sha256: null, checkedBy: null, checkedAt: null, noticesIncluded: false };
    const candidate = await f.candidates.save(actor, { expectedRevision: 1, document: f.document, evidence: unknown });
    const review = await f.service.register(actor, target(candidate), expectation(candidate), "unknown-register");
    await assert.rejects(f.service.decide(actor, review.reviewId, { ...expectation(candidate), expectedRevision: 1, decision: "approved", reason: "无许可", verification }, "unknown-approval"), isCode("SKILL_INVALID"));
    const unchecked = evidence(f.document); unchecked.behavior = { status: "unknown", checkedBy: null, checkedAt: null, note: "未检查" };
    const behavior = await f.candidates.save(actor, { expectedRevision: 2, document: f.document, evidence: unchecked });
    const behaviorReview = await f.service.register(actor, target(behavior), expectation(behavior), "behavior-register");
    await assert.rejects(f.service.decide(actor, behaviorReview.reviewId, { ...expectation(behavior), expectedRevision: 1, decision: "approved", reason: "未检查", verification }, "behavior-approval"), isCode("SKILL_INVALID"));
    await f.database.query("UPDATE skill_candidates SET document=jsonb_set(document,'{manifestHash}',to_jsonb($1::text)) WHERE kind=$2 AND id=$3 AND version_id=$4", ["0".repeat(64), behavior.kind, behavior.id, behavior.versionId]);
    await assert.rejects(f.service.getDetail(actor, behaviorReview.reviewId), isCode("SKILL_CANDIDATE_TAMPERED"));
    assert.equal((await f.repository.listReviews("approved")).length, 0);
  } finally { await f.pg.close(); }
});

test("model, user report and partial test evidence cannot become platform task verification; missing tools need acknowledgement", async () => {
  const f = await setup(); try {
    const falseEvidence = evidence(f.document);
    falseEvidence.compatibility = [{ agentId: "codex", level: "task_verified", source: "model", clientVersion: "test", os: "test", checkedAt: now, evidenceUrl: "https://example.com/evidence", task: "test", limitation: "model claims only" }];
    await assert.rejects(f.candidates.save(actor, { expectedRevision: 1, document: f.document, evidence: falseEvidence }), isCode("INVALID_SKILL_EVIDENCE"));
    falseEvidence.compatibility = falseEvidence.compatibility.map(entry => ({ ...entry, source: "user_reported" }));
    await assert.rejects(f.candidates.save(actor, { expectedRevision: 1, document: f.document, evidence: falseEvidence }), isCode("INVALID_SKILL_EVIDENCE"));
    const partial = evidence(f.document); partial.compatibility = [{ agentId: "codex", level: "file_install_verified", source: "platform_test", clientVersion: "fixture", os: "fixture", checkedAt: now, evidenceUrl: "https://example.com/fixture", task: null, limitation: "隔离夹具仅描述文件阶段，没有真实客户端加载或示例。" }];
    const candidate = await f.candidates.save(actor, { expectedRevision: 1, document: f.document, evidence: partial });
    const review = await f.service.register(actor, target(candidate), expectation(candidate), "partial");
    await assert.rejects(f.service.decide(actor, review.reviewId, { ...expectation(candidate), expectedRevision: 1, decision: "approved", reason: "缺失工具", verification: { ...verification, acknowledgedCompatibility: ["codex"] } }, "missing"), isCode("UNKNOWN_NOT_ACKNOWLEDGED"));
    const decision = await f.service.decide(actor, review.reviewId, { ...expectation(candidate), expectedRevision: 1, decision: "approved", reason: "全部未达到任务验证的限制已保留", verification }, "partial-approved");
    assert.equal(decision.evidence.compatibility[0]?.level, "file_install_verified");
  } finally { await f.pg.close(); }
});

test("withdrawal key is serialized and exact, repeat is idempotent and old publication never revives a withdrawn version", async () => {
  const f = await setup(); try {
    const review = await approved(f.service, f.saved); await f.service.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision }, "publish");
    const input = { ...expectation(f.saved), operationId: "w".repeat(256), reason: "撤回测试" };
    const result = await f.service.withdraw(actor, target(f.saved), input, "withdraw");
    assert.deepEqual(await f.service.withdraw(actor, target(f.saved), input, "withdraw-retry"), result);
    await assert.rejects(f.service.withdraw(actor, target(f.saved), { ...input, reason: "不同理由" }, "different"), isCode("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(f.service.withdraw(actor, target(f.saved), { ...input, expectedManifestHash: "0".repeat(64) }, "different-hash"), isCode("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(f.service.withdraw(actor, { ...target(f.saved), id: "another-skill" }, input, "different-target"), isCode("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(f.service.withdraw({ ...actor, userId: "other-reviewer" }, target(f.saved), input, "different-actor"), isCode("SKILL_NOT_PUBLISHED"));
    await assert.rejects(f.service.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision }, "publish-replay"), isCode("SKILL_WITHDRAWN"));
    assert.equal((await f.service.getDetail(actor, review.reviewId)).candidate.state, "withdrawn");
    assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM operations_skill_review_audit WHERE operation_id=$1", [input.operationId])).rows[0]?.count, 1);
    const key = f.calls.findIndex(sql => sql.includes("SELECT actor_id FROM operations_skill_withdrawal_keys"));
    const candidate = f.calls.findIndex((sql, index) => index > key && sql.includes("SELECT document FROM skill_candidates") && sql.includes("FOR UPDATE")); assert.ok(key > -1 && candidate > key);
  } finally { await f.pg.close(); }
});

test("audit failure rolls M10 publication, operation key and M08 review back in one PostgreSQL transaction", async () => {
  const f = await setup(); try {
    const review = await approved(f.service, f.saved);
    const failing = new SkillReviewService({ repository: { listReviews: (status, limit) => f.repository.listReviews(status, limit), transaction: work => f.repository.transaction(tx => work({ ...tx, appendAudit: async audit => { if (audit.action === "skill_published") throw new Error("isolated audit failure"); return tx.appendAudit(audit); } })) }, skills: createSkillPublicationPort(), clock, ids: f.ids });
    await assert.rejects(failing.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision }, "rollback"), /isolated audit failure/);
    assert.equal((await f.service.getDetail(actor, review.reviewId)).candidate.state, "draft"); assert.equal((await f.repository.listReviews("approved")).length, 1);
    assert.equal((await f.database.query<{ count: number }>("SELECT count(*)::int AS count FROM skill_publication_operations")).rows[0]?.count, 0);
    const catalog = (await f.database.query<{ document: { versions: { id: string }[] } }>("SELECT document FROM skill_catalog WHERE id=$1", [f.saved.id])).rows[0]?.document;
    assert.equal(catalog?.versions.some(version => version.id === f.saved.versionId), false);
  } finally { await f.pg.close(); }
});

test("current actor checks run inside the mutation transaction and failure after publication rolls it back", async () => {
  const f = await setup(); try {
    const review = await approved(f.service, f.saved); let calls = 0;
    const checked = new SkillReviewService({ repository: f.repository, skills: createSkillPublicationPort(), clock, ids: f.ids, assertActorCurrent: async (tx, current) => {
      assert.equal(current.userId, actor.userId); await tx.query("SELECT 1");
      if (++calls === 2) throw new DomainError("SESSION_REVOKED", "会话已失效。", { status: 401 });
    } });
    await assert.rejects(checked.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision }, "revoked"), isCode("SESSION_REVOKED"));
    assert.equal(calls, 2); assert.equal((await f.service.getDetail(actor, review.reviewId)).candidate.state, "draft");
    assert.equal((await f.repository.listReviews("published")).length, 0);
  } finally { await f.pg.close(); }
});

test("fixed bundle uses exact constituent license hashes; withdrawing a constituent blocks approved bundle publication", async () => {
  const f = await setup(); try {
    const skillReview = await approved(f.service, f.saved); await f.service.publish(actor, skillReview.reviewId, { ...expectation(f.saved), expectedRevision: skillReview.revision }, "skill-publish");
    assert.equal(f.document.kind, "skill");
    const bundle: SkillCandidateDocument = { kind: "bundle", bundle: { id: "review-test-kit", version: "1", name: "隔离测试包", track: "general", outcome: "测试固定引用", skillVersionIds: [f.saved.versionId], optionalSkillVersionIds: [], compatibility: "not_live_tested", limitations: ["无真实客户端验收"], steps: ["检查固定版本"], status: "published" } };
    const bundleEvidence = evidence(f.document); bundleEvidence.license.sha256 = bundleLicenseReviewHash(f.document.skill.versions); bundleEvidence.compatibility = [];
    const candidate = await f.candidates.save(actor, { expectedRevision: 0, document: bundle, evidence: bundleEvidence });
    const bundleReview = await approved(f.service, candidate);
    await f.service.withdraw(actor, target(f.saved), { ...expectation(f.saved), operationId: "remove-required", reason: "依赖撤回" }, "withdraw-required");
    await assert.rejects(f.service.publish(actor, bundleReview.reviewId, { ...expectation(candidate), expectedRevision: bundleReview.revision }, "bundle-publish"), isCode("SKILL_INVALID"));
    assert.equal((await f.service.getDetail(actor, bundleReview.reviewId)).candidate.state, "draft");
  } finally { await f.pg.close(); }
});

test("M10 candidate aggregate is locked before the M08 review row", async () => {
  const f = await setup(); try {
    const review = await approved(f.service, f.saved); f.calls.length = 0;
    await f.service.getDetail(actor, review.reviewId);
    const peek = f.calls.findIndex(sql => sql.includes("operations_skill_reviews") && !sql.includes("FOR UPDATE"));
    const candidate = f.calls.findIndex(sql => sql.includes("skill_candidates") && sql.includes("FOR UPDATE"));
    const locked = f.calls.findIndex(sql => sql.includes("operations_skill_reviews") && sql.includes("FOR UPDATE"));
    assert.ok(peek >= 0 && candidate > peek && locked > candidate);
  } finally { await f.pg.close(); }
});

test("a reviewed bundle publishes only its exact fixed constituent set and remains untested in the catalog", async () => {
  const f = await setup(); try {
    const skillReview = await approved(f.service, f.saved); await f.service.publish(actor, skillReview.reviewId, { ...expectation(f.saved), expectedRevision: skillReview.revision }, "skill-publish");
    assert.equal(f.document.kind, "skill");
    const document: SkillCandidateDocument = { kind: "bundle", bundle: { id: "review-published-kit", version: "2", name: "测试固定包", track: "general", outcome: "精确版本输出", skillVersionIds: [f.saved.versionId], optionalSkillVersionIds: [], compatibility: "not_live_tested", limitations: ["工具尚未真实验证"], steps: ["主动选择，再自行安装"], status: "published" } };
    const bundleEvidence = evidence(f.document); bundleEvidence.license.sha256 = bundleLicenseReviewHash(f.document.skill.versions); bundleEvidence.compatibility = [];
    const candidate = await f.candidates.save(actor, { expectedRevision: 0, document, evidence: bundleEvidence });
    const review = await approved(f.service, candidate); const result = await f.service.publish(actor, review.reviewId, { ...expectation(candidate), expectedRevision: review.revision }, "bundle-publish");
    assert.equal(result.manifestHash, candidate.manifestHash); assert.equal((await f.service.getDetail(actor, review.reviewId)).candidate.state, "published");
    const stored = (await f.database.query<{ document: { skillVersionIds: string[]; compatibility: string } }>("SELECT document FROM skill_bundles WHERE id=$1", [candidate.versionId])).rows[0]!.document;
    assert.deepEqual(stored.skillVersionIds, [f.saved.versionId]); assert.equal(stored.compatibility, "not_live_tested");
    await f.service.withdraw(actor, target(candidate), { ...expectation(candidate), operationId: "kit-withdraw", reason: "撤回整包" }, "kit-withdraw");
    await assert.rejects(f.service.publish(actor, review.reviewId, { ...expectation(candidate), expectedRevision: review.revision }, "kit-republish"), isCode("SKILL_WITHDRAWN"));
  } finally { await f.pg.close(); }
});

test("review list and detail authorization is checked after read, including idempotent mutation returns", async () => {
  const f = await setup(); try {
    const review = await approved(f.service, f.saved); await f.service.publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision }, "publish");
    const checkedService = () => { let count = 0; return new SkillReviewService({ repository: f.repository, skills: createSkillPublicationPort(), clock, ids: f.ids, assertActorCurrent: async tx => { await tx.query("SELECT 1"); if (++count === 2) throw new DomainError("SESSION_REVOKED", "读取期间已撤权。", { status: 401 }); } }); };
    await assert.rejects(checkedService().list(actor), isCode("SESSION_REVOKED"));
    await assert.rejects(checkedService().getDetail(actor, review.reviewId), isCode("SESSION_REVOKED"));
    await assert.rejects(checkedService().publish(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: review.revision }, "replay-revoked"), isCode("SESSION_REVOKED"));
    const withdrawal = { ...expectation(f.saved), operationId: "read-replay-key", reason: "测试撤回" }; await f.service.withdraw(actor, target(f.saved), withdrawal, "withdraw");
    await assert.rejects(checkedService().withdraw(actor, target(f.saved), withdrawal, "withdraw-replay-revoked"), isCode("SESSION_REVOKED"));
  } finally { await f.pg.close(); }
});

test("M08 defense refuses model-promoted compatibility from an invalid publication adapter", async () => {
  let invalid: SkillReviewSnapshot | undefined;
  const f = await setup({ skills: port => ({ ...port, readForReview: async (tx, value) => invalid ?? port.readForReview(tx, value) }) }); try {
    invalid = { ...f.saved, validationErrors: [], evidence: { ...f.saved.evidence, compatibility: [{ agentId: "codex", level: "task_verified", source: "model", clientVersion: "fixture", os: "fixture", checkedAt: now, evidenceUrl: "https://example.com/fixture", task: "model", limitation: "不可信模型描述" }] } };
    const review = await f.service.register(actor, target(f.saved), expectation(f.saved), "invalid-port");
    await assert.rejects(f.service.decide(actor, review.reviewId, { ...expectation(f.saved), expectedRevision: 1, decision: "approved", reason: "模型不得标绿", verification }, "model"), isCode("UNTRUSTED_COMPATIBILITY"));
  } finally { await f.pg.close(); }
});
