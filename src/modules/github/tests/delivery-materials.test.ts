import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import type { Actor } from "../../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../../shared/persistence.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { ConfirmedDeliveryRequirements, DeliveryMaterialChecklist, DeliveryMaterialsView, SaveDeliveryMaterialsInput } from "../delivery-materials-types.ts";
import { DeliveryMaterialsService, summarizeDeliveryMaterials } from "../delivery-materials-service.ts";
import { PostgresDeliveryMaterialsStore } from "../delivery-materials-postgres.ts";
import { createGitHubHandler } from "../handlers.ts";
import type { GitService } from "../git-service.ts";
import type { DeliveryService } from "../delivery-service.ts";

const actor: Actor = { userId: "manager-1", platformRoles: ["user"] };
const projectId = "materials-project";
const now = "2026-10-10T04:00:00.000Z";
const commit = "a".repeat(40), olderCommit = "b".repeat(40);
function rules(): ConfirmedDeliveryRequirements {
  return { projectId, eventId: "event-1", requirementsVersion: "event-1:3:2", confirmedAt: "2026-10-09T04:00:00.000Z", materialsStatus: "specified",
    materials: [{ id: "code", label: "源代码", necessity: "required", stageId: "final", evidenceRefs: ["official-evidence-1"] }, { id: "demo", label: "演示视频", necessity: "required", stageId: "final", evidenceRefs: ["official-evidence-2"] }],
    requiredBranch: { status: "specified", name: "main", evidenceRefs: ["official-branch-evidence"] },
    stages: [{ id: "final", name: "最终提交", submissionUrl: "https://event.example/submit", deadline: "2026-10-11T04:00:00.000Z", deadlineRawText: "2026-10-11 12:00 北京时间" }], unknowns: [] };
}
function input(): SaveDeliveryMaterialsInput {
  const verification = { outcome: "passed" as const, verifiedAt: "2026-10-10T03:00:00+00:00", evidenceRefs: ["manual-evidence:screenshot-1"], note: "已实际核对", verificationSource: "user_reported" as const };
  return { expectedVersion: null, eventId: "event-1", requirementsVersion: "event-1:3:2", repositoryCommitSha: commit, idempotencyKey: "materials-key-0001",
    entries: [{ requirementId: "code", location: "https://github.com/team/repo/tree/main", revision: "代码修订1", repositoryCommitSha: commit, verification }, { requirementId: "demo", location: "demo/final.mp4", revision: "视频修订1", repositoryCommitSha: commit, verification }],
    branchVerification: { ...verification, branch: "main", repositoryCommitSha: commit } };
}
function saved(): DeliveryMaterialChecklist {
  const value = input();
  return { ...value, id: "checklist-1", projectId, version: 1, recordedBy: actor.userId, recordedAt: now, inputHash: "fixture-hash", entries: value.entries.map(entry => ({ ...entry, verification: entry.verification ? { ...entry.verification, verifiedBy: actor.userId } : null })), branchVerification: value.branchVerification ? { ...value.branchVerification, verifiedBy: actor.userId } : null };
}
function summary(overrides: Partial<DeliveryMaterialsView> = {}, currentCommit: string | null = commit) { return summarizeDeliveryMaterials({ requirements: rules(), current: saved(), ...overrides }, currentCommit); }

test("材料未加载/分支未知/清单范围未知必须保留缺口与人工核对入口", () => {
  assert.equal(summary({ requirements: null }).status, "not_loaded");
  const unknownBranch = { ...rules(), requiredBranch: { status: "unknown" as const, reason: "规则没有明确分支，请人工核对" } };
  assert.equal(summary({ requirements: unknownBranch }).status, "unknown");
  assert.equal(summary({ requirements: unknownBranch }).branch.status, "unknown");
  assert.ok(summary({ requirements: unknownBranch }).gaps.includes("规则没有明确分支，请人工核对"));
  assert.equal(summary({ requirements: { ...rules(), materials: [], materialsStatus: "unknown" } }).status, "unknown");
  assert.equal(summary({ requirements: null }).recoveryAction, "review_confirmed_event_requirements");
});
test("缺必交、核对失败、规则变化与历史commit均不能变为材料就绪", () => {
  const complete = summary(); assert.equal(complete.status, "ready"); assert.equal(complete.branch.status, "matched"); assert.equal(complete.branch.verificationSource, "user_reported");
  assert.equal(summary({ current: { ...saved(), entries: [saved().entries[0]] } }).status, "missing");
  const failed = saved(); failed.entries[0].verification!.outcome = "failed";
  assert.equal(summary({ current: failed }).materials[0].status, "failed"); assert.equal(summary({ current: failed }).status, "needs_review");
  const outdated = summary({ requirements: { ...rules(), requirementsVersion: "event-1:4:3" } });
  assert.equal(outdated.materials[0].status, "outdated"); assert.equal(outdated.branch.status, "not_verified"); assert.equal(outdated.status, "needs_review");
  assert.equal(summary({}, olderCommit).materials[0].status, "outdated"); assert.equal(summary({}, olderCommit).branch.status, "not_verified");
  assert.equal(summary({}, null).status, "needs_review");
  const wrongBranch = saved(); wrongBranch.branchVerification!.branch = "hackathon/not-merged";
  assert.equal(summary({ current: wrongBranch }).branch.status, "mismatch"); assert.equal(summary({ current: wrongBranch }).status, "needs_review");
});
test("未知必交性质不会因材料核对通过而被确认为完成", () => {
  const unknown = rules(); unknown.materials[0].necessity = "unknown";
  assert.equal(summary({ requirements: unknown }).status, "unknown"); assert.equal(summary({ requirements: unknown }).materials[0].status, "unknown");
});

describe("versioned delivery materials using real SQL in ephemeral PGlite", { concurrency: false }, () => {
  let engine: PGlite, database: DatabasePort, store: PostgresDeliveryMaterialsStore, service: DeliveryMaterialsService;
  let role: "manager" | "member" = "manager", active = true, beforeTransaction: (() => Promise<void>) | null = null, writes = 0;
  function executor(source: PGlite | Transaction): SqlExecutor { return { async query<Row>(statement: string, parameters: readonly unknown[] = []) { const result = await source.query<Row>(statement, [...parameters]); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; } }; }
  before(async () => {
    engine = new PGlite();
    await engine.exec(await readFile(new URL("../sql/delivery-materials.sql", import.meta.url), "utf8"));
    await engine.exec("CREATE TABLE fixture_material_access (project_id text PRIMARY KEY, active boolean, archived boolean, session_valid boolean); CREATE TABLE fixture_material_rules (project_id text PRIMARY KEY, body jsonb)");
    database = { ...executor(engine), async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) { if (beforeTransaction) { const hook = beforeTransaction; beforeTransaction = null; await hook(); } return engine.transaction(tx => work(executor(tx))); } };
    store = new PostgresDeliveryMaterialsStore(database);
    service = new DeliveryMaterialsService({ database, store, access: { async getMembership(project, userId) { return active ? { membershipId: "membership-1", projectId: project, userId, status: "active", role } : null; } },
      writeAccess: { async assertWritable(receivedActor, project, sql) {
        assert.equal(receivedActor, actor); writes++;
        const row = (await sql.query<{ active: boolean; archived: boolean; session_valid: boolean }>("SELECT active,archived,session_valid FROM fixture_material_access WHERE project_id=$1 FOR UPDATE", [project])).rows[0];
        if (!row?.active || !row.session_valid) throw new DomainError("PROJECT_ACCESS_DENIED", "实时权限已撤销", { status: 403 });
        if (row.archived) throw new DomainError("PROJECT_READ_ONLY", "已归档", { status: 409 });
      } }, requirements: { async readConfirmed(_actor, project, sql) { const row = (await (sql ?? database).query<{ body: ConfirmedDeliveryRequirements }>(`SELECT body FROM fixture_material_rules WHERE project_id=$1${sql ? " FOR SHARE" : ""}`, [project])).rows[0]; return row?.body ?? null; } },
      clock: { now: () => new Date(now) }, ids: { next: () => "checklist-1" } });
  });
  beforeEach(async () => {
    role = "manager"; active = true; writes = 0; beforeTransaction = null;
    await engine.exec("DROP TRIGGER IF EXISTS fixture_material_event_failure ON m06_delivery_material_events; TRUNCATE m06_delivery_material_events,m06_delivery_material_versions,m06_delivery_material_heads,fixture_material_access,fixture_material_rules");
    await engine.query("INSERT INTO fixture_material_access VALUES ($1,true,false,true)", [projectId]);
    await engine.query("INSERT INTO fixture_material_rules VALUES ($1,$2::jsonb)", [projectId, JSON.stringify(rules())]);
  });
  after(async () => { await engine.close(); });
  async function changeRules(changes: Partial<ConfirmedDeliveryRequirements>) { await engine.query("UPDATE fixture_material_rules SET body=$2::jsonb WHERE project_id=$1", [projectId, JSON.stringify({ ...rules(), ...changes })]); }
  async function count() { return (await engine.query<{ n: number }>("SELECT count(*)::integer n FROM m06_delivery_material_versions")).rows[0].n; }

  test("同幂等持久重放、CAS连续版本、immutable历史与项目隔离", async () => {
    const records = await Promise.all(Array.from({ length: 3 }, () => service.save(actor, projectId, input())));
    assert.ok(records.every(record => record.version === 1)); assert.equal(await count(), 1);
    assert.deepEqual(await service.save(actor, projectId, { ...input(), entries: [...input().entries].reverse() }), records[0]);
    await assert.rejects(service.save(actor, projectId, { ...input(), repositoryCommitSha: olderCommit, entries: [], branchVerification: null }), { code: "IDEMPOTENCY_KEY_REUSED" });
    const updated = await service.save(actor, projectId, { ...input(), expectedVersion: 1, entries: [], branchVerification: null, idempotencyKey: "materials-key-0002" });
    assert.equal(updated.version, 2); assert.equal(updated.entries.length, 0); assert.equal((await service.read(actor, projectId)).history.length, 2);
    assert.equal((await store.getCurrent(projectId))?.version, 2); assert.equal(await store.getCurrent("other-project"), null); assert.deepEqual(await store.listHistory("other-project"), []);
    await assert.rejects(service.save(actor, projectId, { ...input(), expectedVersion: 1, idempotencyKey: "materials-key-0003" }), { code: "VERSION_CONFLICT" });
    await assert.rejects(engine.query("UPDATE m06_delivery_material_versions SET body=body WHERE project_id=$1", [projectId]), { code: "23514" });
    const events = await engine.query<{ details: unknown }>("SELECT details FROM m06_delivery_material_events ORDER BY version");
    assert.equal(events.rows.length, 2); assert.doesNotMatch(JSON.stringify(events.rows), /final\.mp4|screenshot-1|代码修订1/);
    assert.equal(records[0].entries[0].verification?.verifiedBy, actor.userId);
  });
  test("规则在请求预检后变化，事务内复核拒绝旧版本且没有写入", async () => {
    beforeTransaction = () => changeRules({ requirementsVersion: "event-1:4:3" });
    await assert.rejects(service.save(actor, projectId, input()), { code: "REQUIREMENTS_VERSION_CONFLICT" });
    assert.equal(await count(), 0); assert.equal(writes, 1);
    await engine.query("DELETE FROM fixture_material_rules WHERE project_id=$1", [projectId]);
    await assert.rejects(service.save(actor, projectId, input()), { code: "REQUIREMENTS_VERSION_CONFLICT" });
  });
  test("非成员/成员非管理员、归档、事务内撤权/会话失效均拒写", async () => {
    active = false; await assert.rejects(service.save(actor, projectId, input()), { code: "PROJECT_NOT_FOUND" });
    active = true; role = "member"; await assert.rejects(service.save(actor, projectId, input()), { code: "PROJECT_MANAGER_REQUIRED" });
    role = "manager";
    beforeTransaction = async () => { await engine.query("UPDATE fixture_material_access SET archived=true WHERE project_id=$1", [projectId]); };
    await assert.rejects(service.save(actor, projectId, input()), { code: "PROJECT_READ_ONLY" });
    await engine.query("UPDATE fixture_material_access SET archived=false,active=false WHERE project_id=$1", [projectId]);
    await assert.rejects(service.save(actor, projectId, input()), { code: "PROJECT_ACCESS_DENIED" });
    await engine.query("UPDATE fixture_material_access SET active=true,session_valid=false WHERE project_id=$1", [projectId]);
    await assert.rejects(service.save(actor, projectId, input()), { code: "PROJECT_ACCESS_DENIED" }); assert.equal(await count(), 0);
  });
  test("材料真实位置/修订/版本/证据必需，不能造要求ID或平台确认来源", async () => {
    const modifications = [ { location: null }, { revision: null }, { repositoryCommitSha: olderCommit }, { verification: { ...input().entries[0].verification!, evidenceRefs: [] } }, { requirementId: "dsh-invented-requirement" } ];
    for (const modification of modifications) await assert.rejects(service.save(actor, projectId, { ...input(), entries: [{ ...input().entries[0], ...modification }] }), { code: "INVALID_DELIVERY_MATERIALS" });
    await assert.rejects(service.save(actor, projectId, { ...input(), entries: [{ ...input().entries[0], verification: { ...input().entries[0].verification!, verificationSource: "platform_verified" } as never }] }), { code: "INVALID_DELIVERY_MATERIALS" });
    await assert.rejects(service.save(actor, projectId, { ...input(), entries: [{ ...input().entries[0], location: "javascript:alert(1)" }] }), { code: "INVALID_DELIVERY_MATERIALS" });
    await assert.rejects(service.save(actor, projectId, { ...input(), branchVerification: { ...input().branchVerification!, repositoryCommitSha: olderCommit } }), { code: "INVALID_DELIVERY_MATERIALS" });
    assert.equal(await count(), 0);
  });
  test("SQL事件失败原子回滚head/version，旧CAS不能覆盖清单", async () => {
    await engine.exec("CREATE OR REPLACE FUNCTION fixture_reject_material_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture denied' USING ERRCODE='23514'; END $$; CREATE TRIGGER fixture_material_event_failure BEFORE INSERT ON m06_delivery_material_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_material_event()");
    await assert.rejects(service.save(actor, projectId, input()), { code: "23514" }); assert.equal(await count(), 0); assert.equal(await store.getCurrent(projectId), null);
    await engine.exec("DROP TRIGGER fixture_material_event_failure ON m06_delivery_material_events");
    const previous = await service.save(actor, projectId, input());
    await engine.exec("CREATE TRIGGER fixture_material_event_failure BEFORE INSERT ON m06_delivery_material_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_material_event()");
    await assert.rejects(service.save(actor, projectId, { ...input(), expectedVersion: 1, idempotencyKey: "materials-key-0002" }), { code: "23514" });
    assert.deepEqual(await store.getCurrent(projectId), previous); assert.equal(await count(), 1);
  });
  test("HTTP工厂固定动作、CSRF、可信身份与真实持久清单", async () => {
    const d = { git: {} as GitService, delivery: {} as DeliveryService, materials: service, resolveActor: async () => actor, assertMutationAllowed: async () => {}, requestId: () => "req-materials" };
    const request = () => new Request("https://app.example/api/materials", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input()) });
    const put = await createGitHubHandler(d, "materials.save")(request(), { projectId }); assert.equal(put.status, 200);
    const get = await createGitHubHandler(d, "materials.get")(new Request("https://app.example/api/materials"), { projectId }); const view = (await get.json()).data as DeliveryMaterialsView; assert.equal(view.current?.version, 1); assert.equal(view.requirements?.requirementsVersion, input().requirementsVersion);
    const denied = await createGitHubHandler({ ...d, assertMutationAllowed: async () => { throw new DomainError("CSRF_DENIED", "来源不合法", { status: 403 }); } }, "materials.save")(request(), { projectId }); assert.equal(denied.status, 403);
    const unavailable = await createGitHubHandler({ ...d, materials: undefined }, "materials.get")(new Request("https://app.example/api/materials"), { projectId }); assert.equal(unavailable.status, 503);
    const spoof = new Request("https://app.example/api/materials", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input(), recordedBy: "other" }) });
    assert.equal((await createGitHubHandler(d, "materials.save")(spoof, { projectId })).status, 422);
  });
});
