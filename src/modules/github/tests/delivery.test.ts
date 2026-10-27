import assert from "node:assert/strict";
import test from "node:test";
import type { Actor, ProjectMembershipAccess } from "../../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../../shared/persistence.ts";
import { DomainError } from "../../../shared/errors.ts";
import { DeliveryService, type RecordSubmissionInput, type RecordVerificationInput } from "../delivery-service.ts";
import { PostgresDeliveryStore } from "../delivery-postgres.ts";
import type { DeliveryStorePort, DeliveryVerification, SubmissionRecord } from "../types.ts";

const actor: Actor = { userId: "user-1", platformRoles: ["user"] };
const now = "2026-10-08T08:00:00.000Z";
const commit = "a".repeat(40);

/** Test fixture only; production exports contain only the PostgreSQL adapter. */
class FixtureStore implements DeliveryStorePort {
  verifications: DeliveryVerification[] = [];
  submissions: SubmissionRecord[] = [];
  async insertVerification(record: DeliveryVerification): Promise<void> { this.verifications.push(structuredClone(record)); }
  async listVerifications(projectId: string): Promise<DeliveryVerification[]> { return this.verifications.filter((record) => record.projectId === projectId).map((record) => structuredClone(record)); }
  async insertSubmission(record: SubmissionRecord): Promise<void> { this.submissions.push(structuredClone(record)); }
  async getSubmission(projectId: string, id: string): Promise<SubmissionRecord | null> {
    return structuredClone(this.submissions.filter((record) => record.id === id && record.projectId === projectId).sort((a, b) => b.version - a.version)[0] ?? null);
  }
  async updateSubmission(record: SubmissionRecord, expectedVersion: number): Promise<void> {
    const latest = this.submissions.filter((item) => item.projectId === record.projectId && item.id === record.id).sort((a, b) => b.version - a.version)[0];
    if (!latest || latest.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "冲突", { status: 409, latestRevision: latest?.version });
    this.submissions.push(structuredClone(record));
  }
  async listSubmissions(projectId: string): Promise<SubmissionRecord[]> { return this.submissions.filter((record) => record.projectId === projectId).map((record) => structuredClone(record)); }
}

function fixture() {
  const store = new FixtureStore();
  let membership: ProjectMembershipAccess | null = { membershipId: "membership-1", projectId: "project-1", userId: actor.userId, role: "member", status: "active" };
  let capabilities = { saveRepository: false, verifyDelivery: true, recordSubmission: true };
  let nextId = 0;
  let requirementsReject = false;
  const requirementsCalls: { projectId: string; eventId: string; stageId: string; requirementsVersion: string; platformUrl: string }[] = [];
  const service = new DeliveryService({
    access: { async getMembership() { return membership; } },
    capabilities: { async getCapabilities() { return capabilities; } },
    store, requirements: { async assertConfirmed(input) {
      requirementsCalls.push(input);
      if (requirementsReject) throw new DomainError("REQUIREMENTS_VERSION_CONFLICT", "重新确认规则", { status: 409 });
    } },
    clock: { now: () => new Date(now) }, ids: { next: () => `fact-${++nextId}` },
  });
  return { service, store, requirementsCalls,
    setMembership: (value: ProjectMembershipAccess | null) => { membership = value; },
    setCapabilities: (value: typeof capabilities) => { capabilities = value; },
    rejectRequirements: () => { requirementsReject = true; },
  };
}

function verificationInput(): RecordVerificationInput {
  return { repositoryCommitSha: commit, verifiedAt: "2026-10-08T15:00:00+08:00", environmentSummary: "Chrome，生产预览环境", steps: ["登录后创建项目", "打开交付清单"], outcome: "passed", blockers: [], evidenceRefs: ["private-evidence:demo-1"] };
}
function submissionInput(status: RecordSubmissionInput["status"] = "reported"): RecordSubmissionInput {
  return { eventId: "event-1", stageId: "final", requirementsVersion: "rules-3", platformUrl: "https://event.example/submit", submittedAt: status === "not_submitted" ? null : "2026-10-08T07:30:00Z", repositoryCommitSha: commit, status, evidenceRefs: status === "not_submitted" ? [] : ["private-evidence:receipt-1"] };
}
function errorCode(code: string) { return (error: unknown) => error instanceof DomainError && error.code === code; }

test("公开编辑不能覆盖主办方实际核验的收件事实", async()=>{
  const f=fixture();
  const reported=await f.service.recordSubmission(actor,"project-1",submissionInput());
  f.store.submissions[0]={...reported,status:"verified",verificationSource:"platform_verified"};
  await assert.rejects(f.service.updateSubmission(actor,"project-1",reported.id,1,submissionInput("rejected_or_withdrawn")),errorCode("VERIFIED_RECEIPT_IMMUTABLE"));
  assert.equal(f.store.submissions.length,1);
  assert.equal(f.store.submissions[0].status,"verified");
});

test("验收独立追加，记录可信操作人，并保持仓库保存与赛事提交事实分离", async () => {
  const f = fixture();
  const input = verificationInput();
  const first = await f.service.recordVerification(actor, "project-1", input);
  const second = await f.service.recordVerification(actor, "project-1", { ...input, outcome: "failed", blockers: ["演示接口报错"] });
  assert.notEqual(first.id, second.id);
  assert.equal(first.verifierId, actor.userId);
  assert.equal(first.verifiedAt, "2026-10-08T07:00:00.000Z");
  assert.equal(first.verificationSource, "user_reported");
  assert.equal(first.version, 1);
  input.steps.push("后改输入");
  first.evidenceRefs.push("后改响应");
  assert.equal((await f.service.listVerifications(actor, "project-1")).length, 2);
  assert.deepEqual(f.store.verifications[0].steps, ["登录后创建项目", "打开交付清单"]);
  assert.deepEqual(f.store.verifications[0].evidenceRefs, ["private-evidence:demo-1"]);
  assert.deepEqual(await f.service.listSubmissions(actor, "project-1"), []);
});

test("验收通过必须有环境、步骤、证据且无阻塞；失败与未定不冒充成功", async () => {
  const f = fixture();
  for (const patch of [{ environmentSummary: " " }, { steps: [] }, { evidenceRefs: [] }, { blockers: ["仍未解决"] }]) {
    await assert.rejects(f.service.recordVerification(actor, "project-1", { ...verificationInput(), ...patch }), errorCode("INVALID_DELIVERY_INPUT"));
  }
  const inconclusive = await f.service.recordVerification(actor, "project-1", { ...verificationInput(), outcome: "inconclusive", environmentSummary: "", steps: [], evidenceRefs: [], blockers: ["缺少运行环境"] });
  assert.equal(inconclusive.outcome, "inconclusive");
  assert.equal(f.store.verifications.length, 1);
});

test("成员退出、跨用户/项目不匹配与管理员缺少M06能力均拒绝读取或写入", async () => {
  const f = fixture();
  const membership: ProjectMembershipAccess = { membershipId: "m", projectId: "project-1", userId: actor.userId, role: "manager", status: "active" };
  for (const value of [null, { ...membership, status: "removed" as const }, { ...membership, status: "left" as const }, { ...membership, projectId: "project-2" }, { ...membership, userId: "user-2" }]) {
    f.setMembership(value);
    await assert.rejects(f.service.listVerifications(actor, "project-1"), errorCode("PROJECT_ACCESS_DENIED"));
    await assert.rejects(f.service.listSubmissions(actor, "project-1"), errorCode("PROJECT_ACCESS_DENIED"));
    await assert.rejects(f.service.recordVerification(actor, "project-1", verificationInput()), errorCode("PROJECT_ACCESS_DENIED"));
    await assert.rejects(f.service.recordSubmission(actor, "project-1", submissionInput()), errorCode("PROJECT_ACCESS_DENIED"));
  }
  f.setMembership(membership);
  f.setCapabilities({ saveRepository: true, verifyDelivery: false, recordSubmission: false });
  await assert.rejects(f.service.recordVerification(actor, "project-1", verificationInput()), errorCode("DELIVERY_CAPABILITY_DENIED"));
  await assert.rejects(f.service.recordSubmission(actor, "project-1", submissionInput()), errorCode("DELIVERY_CAPABILITY_DENIED"));
  assert.deepEqual(await f.service.listSubmissions(actor, "project-1"), []);
});

test("即使之前记录成功，每次读取和更新仍重新检查成员资格与能力", async () => {
  const f = fixture();
  const record = await f.service.recordSubmission(actor, "project-1", submissionInput());
  f.setCapabilities({ saveRepository: true, verifyDelivery: true, recordSubmission: false });
  await assert.rejects(f.service.updateSubmission(actor, "project-1", record.id, 1, submissionInput()), errorCode("DELIVERY_CAPABILITY_DENIED"));
  f.setMembership(null);
  await assert.rejects(f.service.updateSubmission(actor, "project-1", record.id, 1, submissionInput()), errorCode("PROJECT_ACCESS_DENIED"));
  await assert.rejects(f.service.listSubmissions(actor, "project-1"), errorCode("PROJECT_ACCESS_DENIED"));
});

test("服务拒绝用户注入记录人、版本、平台确认来源或平台确认状态", async () => {
  const f = fixture();
  for (const patch of [{ verifierId: "someone" }, { version: 5 }, { verificationSource: "platform_verified" }]) {
    await assert.rejects(f.service.recordVerification(actor, "project-1", { ...verificationInput(), ...patch } as unknown as RecordVerificationInput), errorCode("INVALID_DELIVERY_INPUT"));
  }
  for (const patch of [{ recordedBy: "someone" }, { recordedAt: now }, { id: "override" }, { version: 5 }, { status: "verified" }, { verificationSource: "platform_verified" }]) {
    await assert.rejects(f.service.recordSubmission(actor, "project-1", { ...submissionInput(), ...patch } as unknown as RecordSubmissionInput), errorCode("INVALID_DELIVERY_INPUT"));
  }
  assert.equal(f.store.submissions.length, 0);
  assert.equal(f.store.verifications.length, 0);
});

test("验收和提交时间拒绝未来、缺少时区及无效日期", async () => {
  const f = fixture();
  for (const date of ["2026-10-08T08:00:01Z", "2026-10-08T07:00:00", "2026-02-30T07:00:00Z", "2026-10-07T24:00:00Z", "not-a-date"]) {
    await assert.rejects(f.service.recordVerification(actor, "project-1", { ...verificationInput(), verifiedAt: date }), errorCode("INVALID_DELIVERY_INPUT"));
    await assert.rejects(f.service.recordSubmission(actor, "project-1", { ...submissionInput(), submittedAt: date }), errorCode("INVALID_DELIVERY_INPUT"));
  }
});

test("已提交必须有证据和时间，未提交不伪造提交时间", async () => {
  const f = fixture();
  await assert.rejects(f.service.recordSubmission(actor, "project-1", { ...submissionInput(), evidenceRefs: [] }), errorCode("INVALID_DELIVERY_INPUT"));
  await assert.rejects(f.service.recordSubmission(actor, "project-1", { ...submissionInput(), submittedAt: null }), errorCode("INVALID_DELIVERY_INPUT"));
  await assert.rejects(f.service.recordSubmission(actor, "project-1", { ...submissionInput("not_submitted"), submittedAt: now }), errorCode("INVALID_DELIVERY_INPUT"));
  const record = await f.service.recordSubmission(actor, "project-1", submissionInput("not_submitted"));
  assert.equal(record.submittedAt, null);
  assert.equal(record.recordedAt, now);
});

test("提交入口只接受不含账号凭据的HTTPS，确认规则port包含完整项目阶段关联", async () => {
  const f = fixture();
  for (const platformUrl of ["http://event.example/submit", "https://user:secret@event.example/submit", "javascript:alert(1)", "not-a-url"]) {
    await assert.rejects(f.service.recordSubmission(actor, "project-1", { ...submissionInput(), platformUrl }), errorCode("INVALID_DELIVERY_INPUT"));
  }
  await f.service.recordSubmission(actor, "project-1", submissionInput());
  assert.deepEqual(f.requirementsCalls[0], { projectId: "project-1", eventId: "event-1", stageId: "final", requirementsVersion: "rules-3", platformUrl: "https://event.example/submit" });
  f.rejectRequirements();
  await assert.rejects(f.service.recordSubmission(actor, "project-1", { ...submissionInput(), requirementsVersion: "old" }), errorCode("REQUIREMENTS_VERSION_CONFLICT"));
  assert.equal(f.store.submissions.length, 1);
});

test("提交版本追加保存，更新可信记录人与时间，并保留既有历史", async () => {
  const f = fixture();
  const original = await f.service.recordSubmission(actor, "project-1", submissionInput("not_submitted"));
  const update = await f.service.updateSubmission(actor, "project-1", original.id, 1, submissionInput());
  assert.equal(update.version, 2);
  assert.equal(update.id, original.id);
  assert.equal(update.recordedBy, actor.userId);
  assert.equal(update.verificationSource, "user_reported");
  const latest = await f.store.getSubmission("project-1", original.id);
  assert.equal(latest?.status, "reported");
  const history = await f.service.listSubmissions(actor, "project-1");
  assert.deepEqual(history.map((record) => [record.version, record.status]), [[1, "not_submitted"], [2, "reported"]]);
  assert.equal(history[0].submittedAt, null);
  assert.deepEqual(await f.service.listVerifications(actor, "project-1"), []);
});

test("并发更新只有一个预期版本成功，另一个返回冲突且不覆盖历史", async () => {
  const f = fixture();
  const original = await f.service.recordSubmission(actor, "project-1", submissionInput("not_submitted"));
  const result = await Promise.allSettled([
    f.service.updateSubmission(actor, "project-1", original.id, 1, submissionInput()),
    f.service.updateSubmission(actor, "project-1", original.id, 1, { ...submissionInput(), evidenceRefs: ["different-receipt"] }),
  ]);
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = result.find((item) => item.status === "rejected");
  assert.ok(rejected?.status === "rejected" && errorCode("VERSION_CONFLICT")(rejected.reason));
  assert.deepEqual(f.store.submissions.map((record) => record.version), [1, 2]);
  await assert.rejects(f.service.updateSubmission(actor, "project-1", original.id, 1, submissionInput()), (error: unknown) => errorCode("VERSION_CONFLICT")(error) && (error as DomainError).latestRevision === 2);
});

test("更新拒绝跨项目、跨赛事阶段、无效版本与已过期规则，均不新增历史", async () => {
  const f = fixture();
  const original = await f.service.recordSubmission(actor, "project-1", submissionInput("not_submitted"));
  await assert.rejects(f.service.updateSubmission(actor, "project-1", "missing", 1, submissionInput()), errorCode("SUBMISSION_NOT_FOUND"));
  for (const expectedVersion of [0, -1, 1.5, NaN]) await assert.rejects(f.service.updateSubmission(actor, "project-1", original.id, expectedVersion, submissionInput()), errorCode("INVALID_DELIVERY_INPUT"));
  for (const patch of [{ eventId: "another" }, { stageId: "qualifier" }]) await assert.rejects(f.service.updateSubmission(actor, "project-1", original.id, 1, { ...submissionInput(), ...patch }), errorCode("INVALID_DELIVERY_INPUT"));
  f.rejectRequirements();
  await assert.rejects(f.service.updateSubmission(actor, "project-1", original.id, 1, submissionInput()), errorCode("REQUIREMENTS_VERSION_CONFLICT"));
  f.setMembership({ membershipId: "m2", userId: actor.userId, projectId: "project-2", role: "member", status: "active" });
  await assert.rejects(f.service.updateSubmission(actor, "project-2", original.id, 1, submissionInput()), errorCode("SUBMISSION_NOT_FOUND"));
  assert.equal(f.store.submissions.length, 1);
});

class RecordingDatabase implements DatabasePort {
  calls: { statement: string; parameters: readonly unknown[]; inTransaction: boolean }[] = [];
  responses: SqlResult<unknown>[] = [];
  commits = 0;
  rollbacks = 0;
  inTransaction = false;
  failPattern: RegExp | null = null;
  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ statement, parameters: structuredClone(parameters), inTransaction: this.inTransaction });
    if (this.failPattern?.test(statement)) throw new Error("fixture database write failed");
    return (this.responses.shift() ?? { rows: [], rowCount: 1 }) as SqlResult<Row>;
  }
  async transaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    this.inTransaction = true;
    try { const value = await work(this); this.commits++; return value; }
    catch (error) { this.rollbacks++; throw error; }
    finally { this.inTransaction = false; }
  }
}

function submissionRecord(version = 1): SubmissionRecord {
  return { ...submissionInput(), id: "submission-1", projectId: "project-1", submittedAt: "2026-10-08T07:30:00.000Z", repositoryCommitSha: commit, verificationSource: "user_reported", recordedBy: actor.userId, recordedAt: now, version };
}

test("PostgreSQL新提交在同一事务建立head与版本，SQL全部参数化", async () => {
  const database = new RecordingDatabase();
  const store = new PostgresDeliveryStore(database);
  const record = { ...submissionRecord(), eventId: "event'; DROP TABLE secrets;--" };
  await store.insertSubmission(record);
  assert.equal(database.commits, 1);
  assert.equal(database.calls.length, 3);
  assert.ok(database.calls.every((call) => call.inTransaction));
  assert.match(database.calls[0].statement, /INSERT INTO m06_submission_heads/);
  assert.match(database.calls[1].statement, /INSERT INTO m06_submission_versions/);
  assert.ok(database.calls.every((call) => !call.statement.includes(record.eventId)));
  assert.equal(database.calls[1].parameters[3], record.eventId);
  assert.match(database.calls[2].statement, /INSERT INTO m06_delivery_fact_events/);
  assert.equal(database.calls[2].parameters[1], "SubmissionRecorded");
  assert.equal(database.calls[2].parameters[4], 1);
  assert.ok(!(database.calls[2].parameters[6] as string).includes("private-evidence"));
});

test("PostgreSQL版本CAS与追加在同一事务，旧历史没有UPDATE/DELETE", async () => {
  const database = new RecordingDatabase();
  const store = new PostgresDeliveryStore(database);
  await store.updateSubmission(submissionRecord(2), 1);
  assert.equal(database.commits, 1);
  assert.ok(database.calls.every((call) => call.inTransaction));
  assert.match(database.calls[0].statement, /UPDATE m06_submission_heads.*version=\$4/s);
  assert.deepEqual(database.calls[0].parameters, [2, "project-1", "submission-1", 1]);
  assert.match(database.calls[1].statement, /INSERT INTO m06_submission_versions/);
  assert.equal(database.calls[2].parameters[1], "SubmissionRecorded");
  assert.equal(database.calls[2].parameters[4], 2);
  assert.ok(database.calls.every((call) => !/(?:UPDATE|DELETE FROM) m06_submission_versions/.test(call.statement)));
});

test("PostgreSQL并发CAS失败返回最新版本且不写入历史，并退出事务", async () => {
  const database = new RecordingDatabase();
  database.responses = [{ rows: [], rowCount: 0 }, { rows: [{ version: 4 }], rowCount: 1 }];
  const store = new PostgresDeliveryStore(database);
  await assert.rejects(store.updateSubmission(submissionRecord(2), 1), (error: unknown) => errorCode("VERSION_CONFLICT")(error) && (error as DomainError).latestRevision === 4);
  assert.equal(database.rollbacks, 1);
  assert.equal(database.commits, 0);
  assert.equal(database.calls.length, 2);
  assert.ok(database.calls.every((call) => !call.statement.includes("INSERT INTO m06_submission_versions")));
});

test("PostgreSQL CAS后历史插入失败必须回滚事务并保留错误", async () => {
  const database = new RecordingDatabase();
  database.failPattern = /INSERT INTO m06_submission_versions/;
  const store = new PostgresDeliveryStore(database);
  await assert.rejects(store.updateSubmission(submissionRecord(2), 1), /fixture database write failed/);
  assert.equal(database.commits, 0);
  assert.equal(database.rollbacks, 1);
  assert.equal(database.calls.length, 2);
  assert.ok(database.calls.every((call) => call.inTransaction));
});

test("PostgreSQL事实事件写入失败回滚事实，避免返回没有审计的成功", async () => {
  const database = new RecordingDatabase();
  database.failPattern = /INSERT INTO m06_delivery_fact_events/;
  const store = new PostgresDeliveryStore(database);
  await assert.rejects(store.insertSubmission(submissionRecord()), /fixture database write failed/);
  assert.equal(database.commits, 0);
  assert.equal(database.rollbacks, 1);
  assert.equal(database.calls.length, 3);
  assert.ok(database.calls.every((call) => call.inTransaction));
});

test("PostgreSQL更新不存在/跨项目head返回404；不连续版本在SQL前拒绝", async () => {
  const database = new RecordingDatabase();
  database.responses = [{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }];
  const store = new PostgresDeliveryStore(database);
  await assert.rejects(store.updateSubmission(submissionRecord(2), 1), errorCode("SUBMISSION_NOT_FOUND"));
  assert.deepEqual(database.calls[1].parameters, ["project-1", "submission-1"]);
  const callsBefore = database.calls.length;
  await assert.rejects(store.updateSubmission(submissionRecord(4), 1), errorCode("INVALID_DELIVERY_INPUT"));
  assert.equal(database.calls.length, callsBefore);
});

test("PostgreSQL当前提交读取用head关联版本，列表仍返回全部版本并规范化日期", async () => {
  const database = new RecordingDatabase();
  const row = { id: "submission-1", project_id: "project-1", event_id: "event-1", stage_id: "final", requirements_version: "rules-3", platform_url: "https://event.example/submit", submitted_at: new Date("2026-10-08T07:30:00Z"), verification_source: "user_reported", repository_commit_sha: commit, status: "reported", evidence_refs: ["receipt"], recorded_by: actor.userId, recorded_at: new Date(now), version: 2 };
  database.responses = [{ rows: [row], rowCount: 1 }, { rows: [{ ...row, version: 1, status: "not_submitted", submitted_at: null }, row], rowCount: 2 }];
  const store = new PostgresDeliveryStore(database);
  const current = await store.getSubmission("project-1", "submission-1");
  assert.match(database.calls[0].statement, /h.version=v.version/);
  assert.deepEqual(database.calls[0].parameters, ["project-1", "submission-1"]);
  assert.equal(current?.submittedAt, "2026-10-08T07:30:00.000Z");
  const history = await store.listSubmissions("project-1");
  assert.equal(history.length, 2);
  assert.deepEqual(database.calls[1].parameters, ["project-1"]);
  assert.equal(history[0].submittedAt, null);
});

test("PostgreSQL验收使用独立表追加，读取限定项目并还原证据与时间", async () => {
  const database = new RecordingDatabase();
  const store = new PostgresDeliveryStore(database);
  const record: DeliveryVerification = { ...verificationInput(), repositoryCommitSha: commit, id: "verification-1", projectId: "project-1", verifierId: actor.userId, verifiedAt: "2026-10-08T07:00:00.000Z", verificationSource: "user_reported", version: 1 };
  await store.insertVerification(record);
  assert.match(database.calls[0].statement, /INSERT INTO m06_delivery_verifications/);
  assert.equal(database.calls[0].parameters[4], actor.userId);
  assert.equal(database.calls[0].parameters[11], "user_reported");
  assert.equal(database.calls[1].parameters[1], "DeliveryValidationRecorded");
  assert.ok(!(database.calls[1].parameters[6] as string).includes("private-evidence"));
  database.responses = [{ rows: [{ id: record.id, project_id: record.projectId, version: 1, repository_commit_sha: commit, verifier_id: actor.userId, verified_at: new Date(record.verifiedAt), environment_summary: record.environmentSummary, steps: record.steps, outcome: "passed", blockers: [], evidence_refs: record.evidenceRefs, verification_source: "user_reported" }], rowCount: 1 }];
  assert.deepEqual(await store.listVerifications("project-1"), [record]);
  assert.deepEqual(database.calls[2].parameters, ["project-1"]);
  assert.match(database.calls[2].statement, /WHERE project_id=\$1/);
});
