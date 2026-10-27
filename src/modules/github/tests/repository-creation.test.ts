import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../../shared/persistence.ts";
import type { CreatedRepository, RepositoryCreationDependencies, RepositoryCreationOperation, RepositoryCreationStorePort } from "../authorization-types.ts";
import { RepositoryCreationService, repositoryCreationInputHash, type RepositoryCreationInput } from "../repository-creation.ts";
import { PostgresRepositoryCreationStore } from "../repository-creation-postgres.ts";

const actor: Actor = { userId: "creation-user", platformRoles: ["user"] };
const projectId = "creation-project";
const initialNow = "2026-10-08T08:00:00.000Z";
const clone = <T>(value: T): T => structuredClone(value);
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

/** Test-only storage; never exported as a production adapter. */
class FixtureStore implements RepositoryCreationStorePort {
  operations = new Map<string, RepositoryCreationOperation>();
  failAcknowledgedPersist = false;
  async findByKey(project: string, user: string, key: string): Promise<RepositoryCreationOperation | null> {
    return clone([...this.operations.values()].find(operation => operation.projectId === project && operation.userId === user && operation.idempotencyKey === key) ?? null);
  }
  async get(project: string, user: string, id: string): Promise<RepositoryCreationOperation | null> {
    const operation = this.operations.get(id);
    return operation?.projectId === project && operation.userId === user ? clone(operation) : null;
  }
  async insert(operation: RepositoryCreationOperation): Promise<RepositoryCreationOperation> {
    const existing = [...this.operations.values()].find(value => value.projectId === operation.projectId && value.userId === operation.userId && value.idempotencyKey === operation.idempotencyKey);
    if (existing) {
      if (repositoryCreationInputHash(existing) !== repositoryCreationInputHash(operation)) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "changed", { status: 409 });
      return clone(existing);
    }
    this.operations.set(operation.id, clone(operation)); return clone(operation);
  }
  async update(operation: RepositoryCreationOperation, expectedRevision: number): Promise<void> {
    const existing = this.operations.get(operation.id);
    if (!existing || existing.revision !== expectedRevision) throw new DomainError("VERSION_CONFLICT", "changed", { status: 409 });
    if (this.failAcknowledgedPersist && operation.repository && !existing.repository) {
      this.failAcknowledgedPersist = false;
      throw new DomainError("STORE_TEMPORARILY_UNAVAILABLE", "fixture persistence failed", { status: 429 });
    }
    this.operations.set(operation.id, clone(operation));
  }
}

function input(privateRepository = true): RepositoryCreationInput {
  return { name: "hackathon-project", description: "参赛作品 🌱", private: privateRepository, idempotencyKey: "create-key-001" };
}
function fixture() {
  const store = new FixtureStore();
  const state = {
    active: true, manager: true, save: true, websiteUserId: actor.userId, credentialGithubUserId: 42,
    githubUserId: 42, githubLogin: "creation-person", tokenKind: "github_app_user", now: new Date(initialNow),
    repository: null as CreatedRepository | null, writes: 0, reads: 0, identityReads: 0, initialized: true,
    loseCreateResponse: false, denyCreate: false, failReadback: false, returnedWrongId: false,
    beforeCreate: async () => {}, afterCreate: () => {}, onRead: () => {}, sentInput: null as { name: string; description: string; private: boolean } | null,
  };
  let ids = 0;
  const dependencies: RepositoryCreationDependencies = {
    appId: 3, store,
    access: { async getMembership(project, user) { return state.active && project === projectId ? { projectId: project, userId: user, membershipId: "creation-membership", status: "active", role: state.manager ? "manager" : "member" } : null; } },
    capabilities: { async getCapabilities() { return { saveRepository: state.save, verifyDelivery: false, recordSubmission: false }; } },
    credentials: { async getAuthorizationCredential() { return { token: "fixture-server-token", tokenKind: state.tokenKind as "github_app_user", websiteUserId: state.websiteUserId, githubUserId: state.credentialGithubUserId }; } },
    clock: { now: () => new Date(state.now) }, ids: { next: () => `creation-${++ids}` },
    http: {
      async exchangeCode() { throw new Error("not used"); }, async refreshToken() { throw new Error("not used"); }, async revokeGrant() { throw new Error("not used"); }, async revokeToken() { throw new Error("not used"); },
      async listInstallations() { throw new Error("must not install or bind"); }, async listRepositories() { throw new Error("must not discover or bind"); },
      async getIdentity(token) { assert.equal(token, "fixture-server-token"); state.identityReads++; return { id: state.githubUserId, login: state.githubLogin, profileUrl: `https://github.com/${state.githubLogin}` }; },
      async getRepository(token, owner, name) {
        assert.equal(token, "fixture-server-token"); assert.equal(owner, "creation-person"); assert.equal(name, "hackathon-project"); state.reads++; state.onRead();
        if (state.failReadback && state.writes) throw new DomainError("GITHUB_SERVICE_UNAVAILABLE", "read failed", { status: 503 });
        return state.repository ? clone(state.repository) : null;
      },
      async createRepository(token, payload) {
        assert.equal(token, "fixture-server-token"); await state.beforeCreate();
        if (state.denyCreate) throw new DomainError("GITHUB_PERMISSION_DENIED", "not permitted", { status: 403 });
        state.writes++; state.sentInput = clone(payload);
        state.repository = { repositoryId: 101, owner: "creation-person", name: payload.name, url: `https://github.com/creation-person/${payload.name}`, private: payload.private, description: payload.description, defaultBranch: "main", initialized: state.initialized };
        state.afterCreate();
        if (state.loseCreateResponse) throw Object.assign(new DomainError("GITHUB_OUTCOME_UNKNOWN", "response lost", { status: 503 }), { outcomeUnknown: true });
        return clone({ ...state.repository, repositoryId: state.returnedWrongId ? 202 : state.repository.repositoryId });
      },
    },
  };
  return { state, store, dependencies, service: new RepositoryCreationService(dependencies) };
}

test("个人仓库预览仅由当前GitHub身份指定owner，显式可见性与autoInit绑定15分钟确认", async () => {
  const f = fixture();
  const operation = await f.service.preview(actor, projectId, input());
  assert.equal(operation.owner, "creation-person"); assert.equal(operation.userId, actor.userId); assert.equal(operation.githubUserId, 42);
  assert.equal(operation.appId, 3); assert.equal(operation.private, true); assert.equal(operation.autoInit, true);
  assert.equal(operation.expiresAt, "2026-10-08T08:15:00.000Z"); assert.match(operation.confirmationHash, /^[a-f0-9]{64}$/);
  assert.equal(operation.status, "preview"); assert.equal(operation.repository, null); assert.equal(f.state.writes, 0);
  assert.ok(!JSON.stringify(operation).includes("fixture-server-token"));
});

for (const visibility of [true, false]) {
  test(`显式${visibility ? "私有" : "公开"}确认才创建并读回已初始化仓库，不自动安装或绑定`, async () => {
    const f = fixture();
    const operation = await f.service.preview(actor, projectId, input(visibility));
    const created = await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash);
    assert.equal(created.status, "created"); assert.equal(created.repository?.repositoryId, 101); assert.equal(created.repository?.initialized, true);
    assert.equal(created.repository?.private, visibility); assert.equal(created.autoInit, true); assert.equal(f.state.writes, 1);
    assert.deepEqual(f.state.sentInput, { name: input().name, description: input().description, private: visibility });
    assert.ok(f.state.reads >= 3);
    const repeat = await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash);
    assert.equal(repeat.status, "created"); assert.equal(f.state.writes, 1);
    assert.ok(!("bindingId" in created));
  });
}

test("同项目用户幂等键重复预览返回原事实；同键不同公开范围/名称/说明拒绝", async () => {
  const f = fixture();
  const original = await f.service.preview(actor, projectId, input());
  const same = await f.service.preview(actor, projectId, input());
  assert.deepEqual(same, original); assert.equal(f.store.operations.size, 1);
  for (const patch of [{ private: false }, { name: "another-repository" }, { description: "其他说明" }]) {
    await assert.rejects(f.service.preview(actor, projectId, { ...input(), ...patch }), code("IDEMPOTENCY_KEY_REUSED"));
  }
  const created = await f.service.confirm(actor, projectId, original.id, original.confirmationHash);
  assert.deepEqual(await f.service.preview(actor, projectId, input()), created);
  assert.equal(f.state.writes, 1);
});

test("拒绝缺少显式private、非法名称/过长说明以及owner/token/mode/autoInit等额外字段", async () => {
  const f = fixture();
  const invalidInputs = [
    { ...input(), private: undefined }, { ...input(), private: "false" },
    ...["", ".", "..", "...", ".git", "name.GIT", "owner/repository", "path\\repo", "name\n", "a".repeat(101)].map(name => ({ ...input(), name })),
    ...["a".repeat(351), "text\nline", "x\u0000y", "\ud800", "x\u202ey"].map(description => ({ ...input(), description })),
    ...["owner", "user", "userId", "token", "mode", "autoInit"].map(key => ({ ...input(), [key]: key === "autoInit" ? false : "injected" })),
  ];
  for (const value of invalidInputs) await assert.rejects(f.service.preview(actor, projectId, value as unknown as RepositoryCreationInput), code("INVALID_REPOSITORY_CREATION"));
  assert.equal(f.store.operations.size, 0); assert.equal(f.state.writes, 0); assert.equal(f.state.identityReads, 0);
});

test("确认哈希错误或预览过期均不发出远端创建", async () => {
  const f = fixture(); const operation = await f.service.preview(actor, projectId, input());
  await assert.rejects(f.service.confirm(actor, projectId, operation.id, "wrong-hash"), code("REPOSITORY_CREATION_CONFIRMATION_REQUIRED"));
  f.state.now = new Date(operation.expiresAt);
  await assert.rejects(f.service.confirm(actor, projectId, operation.id, operation.confirmationHash), code("REPOSITORY_CREATION_PREVIEW_EXPIRED"));
  assert.equal(f.state.writes, 0);
});

test("公开/私有与actor/project身份均参与哈希，存储中改输入但沿用旧哈希不能确认", async () => {
  const f = fixture(); const operation = await f.service.preview(actor, projectId, input());
  f.store.operations.set(operation.id, { ...operation, private: false });
  await assert.rejects(f.service.confirm(actor, projectId, operation.id, operation.confirmationHash), code("REPOSITORY_CREATION_CONFIRMATION_REQUIRED"));
  assert.notEqual(repositoryCreationInputHash(operation), repositoryCreationInputHash({ ...operation, projectId: "other-project" }));
  assert.notEqual(repositoryCreationInputHash(operation), repositoryCreationInputHash({ ...operation, userId: "other-user" }));
  assert.equal(f.state.writes, 0);
});

test("活跃manager与M06能力分别检查；移除/降级/撤销后不能确认", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.active = false; }, (f: ReturnType<typeof fixture>) => { f.state.manager = false; }, (f: ReturnType<typeof fixture>) => { f.state.save = false; }]) {
    const f = fixture(); const operation = await f.service.preview(actor, projectId, input()); change(f);
    await assert.rejects(f.service.confirm(actor, projectId, operation.id, operation.confirmationHash), (error: unknown) => error instanceof DomainError && [403, 404].includes(error.status));
    assert.equal(f.state.writes, 0);
  }
});

test("仓库存在核对期间成员权限失效或预览到期也阻止POST", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.active = false; }, (f: ReturnType<typeof fixture>) => { f.state.now = new Date("2026-10-08T08:15:00.000Z"); }]) {
    const f = fixture(); const operation = await f.service.preview(actor, projectId, input()); f.state.onRead = () => change(f);
    await assert.rejects(f.service.confirm(actor, projectId, operation.id, operation.confirmationHash), (error: unknown) => error instanceof DomainError);
    assert.equal(f.state.writes, 0);
  }
});

test("凭据必须属于网站用户与GitHub App用户令牌，真实identity不能与保存身份冲突", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.websiteUserId = "other-user"; }, (f: ReturnType<typeof fixture>) => { f.state.tokenKind = "installation"; }, (f: ReturnType<typeof fixture>) => { f.state.githubUserId = 999; }]) {
    const f = fixture(); change(f);
    await assert.rejects(f.service.preview(actor, projectId, input()), (error: unknown) => error instanceof DomainError && error.status === 403);
    assert.equal(f.state.writes, 0);
  }
  const f = fixture(); const operation = await f.service.preview(actor, projectId, input());
  f.state.githubUserId = 43; f.state.credentialGithubUserId = 43;
  await assert.rejects(f.service.confirm(actor, projectId, operation.id, operation.confirmationHash), code("GITHUB_IDENTITY_CHANGED"));
  assert.equal(f.state.writes, 0);
});

test("已有同名仓库拒绝预览；预览后他人创建同名仓库只标blocked不覆盖", async () => {
  const f = fixture();
  const existing: CreatedRepository = { repositoryId: 500, owner: "creation-person", name: input().name, url: `https://github.com/creation-person/${input().name}`, private: true, defaultBranch: "main", initialized: true, description: input().description! };
  f.state.repository = existing;
  await assert.rejects(f.service.preview(actor, projectId, input()), code("REPOSITORY_ALREADY_EXISTS"));
  assert.equal(f.store.operations.size, 0);
  f.state.repository = null;
  const operation = await f.service.preview(actor, projectId, input());
  f.state.repository = existing;
  const blocked = await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash);
  assert.equal(blocked.status, "blocked"); assert.equal(blocked.errorCode, "REPOSITORY_ALREADY_EXISTS"); assert.equal(f.state.writes, 0);
});

test("并发预览共享唯一事实，并发确认通过CAS仅发出一次创建", async () => {
  const f = fixture();
  const previews = await Promise.all([f.service.preview(actor, projectId, input()), f.service.preview(actor, projectId, input())]);
  assert.equal(previews[0].id, previews[1].id); assert.equal(f.store.operations.size, 1);
  const operation = previews[0];
  const result = await Promise.all([f.service.confirm(actor, projectId, operation.id, operation.confirmationHash), f.service.confirm(actor, projectId, operation.id, operation.confirmationHash)]);
  assert.equal(f.state.writes, 1);
  assert.ok(result.some(item => item.status === "created"));
  assert.ok(result.every(item => ["creating", "created"].includes(item.status)));
});

test("远端POST响应丢失时无确认ID；同名GET存在也只能unknown，重复确认/核对均不POST", async () => {
  const f = fixture(); f.state.loseCreateResponse = true;
  const operation = await f.service.preview(actor, projectId, input());
  const unknown = await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash);
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.repository, null); assert.equal(f.state.writes, 1);
  assert.equal((await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash)).status, "unknown");
  const reconciled = await f.service.reconcile(actor, projectId, operation.id);
  assert.equal(reconciled.status, "unknown"); assert.equal(reconciled.repository, null); assert.equal(reconciled.errorCode, "REPOSITORY_CREATION_UNACKNOWLEDGED_CANDIDATE");
  f.state.repository = null;
  assert.equal((await f.service.reconcile(actor, projectId, operation.id)).status, "unknown"); assert.equal(f.state.writes, 1);
});

test("收到已确认仓库ID但读回失败保留ack，核对同ID初始化事实后created", async () => {
  const f = fixture(); f.state.failReadback = true;
  const operation = await f.service.preview(actor, projectId, input());
  const unknown = await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash);
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.repository?.repositoryId, 101);
  f.state.failReadback = false;
  const reconciled = await f.service.reconcile(actor, projectId, operation.id);
  assert.equal(reconciled.status, "created"); assert.equal(reconciled.repository?.initialized, true); assert.equal(f.state.writes, 1);
});

test("HTTP 201已核验metadata但初始化读回失败返回initialized:false，保留ID后只读恢复", async () => {
  const f = fixture(); f.state.initialized = false; f.state.failReadback = true;
  const operation = await f.service.preview(actor, projectId, input());
  const unknown = await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash);
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.repository?.repositoryId, 101); assert.equal(unknown.repository?.initialized, false);
  f.state.failReadback = false; f.state.repository = { ...f.state.repository!, initialized: true };
  const restored = await f.service.reconcile(actor, projectId, operation.id);
  assert.equal(restored.status, "created"); assert.equal(restored.repository?.repositoryId, 101); assert.equal(restored.repository?.initialized, true); assert.equal(f.state.writes, 1);
});

test("远端已返回确认ID后首次保存失败保持unknown并保留ack，不能当作可重试blocked", async () => {
  const f = fixture(); const operation = await f.service.preview(actor, projectId, input()); f.store.failAcknowledgedPersist = true;
  const unknown = await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash);
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.repository?.repositoryId, 101); assert.equal(f.state.writes, 1);
  assert.equal((await f.service.reconcile(actor, projectId, operation.id)).status, "created"); assert.equal(f.state.writes, 1);
});

test("当前身份login大小写变化仍匹配个人账号，实际改名则要求重新预览", async () => {
  const f = fixture(); const operation = await f.service.preview(actor, projectId, input());
  f.state.githubLogin = "Creation-Person";
  assert.equal((await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash)).status, "created");
  const renamed = fixture(); const preview = await renamed.service.preview(actor, projectId, input()); renamed.state.githubLogin = "renamed-person";
  await assert.rejects(renamed.service.confirm(actor, projectId, preview.id, preview.confirmationHash), code("GITHUB_IDENTITY_CHANGED")); assert.equal(renamed.state.writes, 0);
});

test("未初始化或读回不同ID不得created，同ID真实初始化后才可核对成功", async () => {
  const f = fixture(); f.state.initialized = false;
  const operation = await f.service.preview(actor, projectId, input());
  const unknown = await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash);
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.errorCode, "REPOSITORY_NOT_INITIALIZED");
  f.state.repository = { ...f.state.repository!, repositoryId: 999, initialized: true };
  assert.equal((await f.service.reconcile(actor, projectId, operation.id)).status, "unknown");
  f.state.repository = { ...f.state.repository, repositoryId: 101 };
  assert.equal((await f.service.reconcile(actor, projectId, operation.id)).status, "created"); assert.equal(f.state.writes, 1);
});

test("明确403拒绝后blocked，不能重复确认盲目重试创建", async () => {
  const f = fixture(); f.state.denyCreate = true;
  const operation = await f.service.preview(actor, projectId, input());
  const blocked = await f.service.confirm(actor, projectId, operation.id, operation.confirmationHash);
  assert.equal(blocked.status, "blocked"); assert.equal(blocked.errorCode, "GITHUB_PERMISSION_DENIED");
  f.state.denyCreate = false;
  await assert.rejects(f.service.confirm(actor, projectId, operation.id, operation.confirmationHash), code("REPOSITORY_CREATION_RETRY_BLOCKED"));
  assert.equal(f.state.writes, 0);
});

test("进行中有效lease核对不抢占；过期后只读取，不借空仓库重试POST", async () => {
  const f = fixture(); const operation = await f.service.preview(actor, projectId, input());
  f.store.operations.set(operation.id, { ...operation, status: "creating", revision: 2, leaseUntil: "2026-10-08T08:05:00.000Z" });
  const reads = f.state.reads;
  assert.equal((await f.service.reconcile(actor, projectId, operation.id)).status, "creating"); assert.equal(f.state.reads, reads);
  f.state.now = new Date("2026-10-08T08:05:00.000Z");
  assert.equal((await f.service.reconcile(actor, projectId, operation.id)).status, "unknown"); assert.equal(f.state.writes, 0);
});

test("操作get按project与user限定，其他活跃manager也不能读取个人创建operation", async () => {
  const f = fixture(); const operation = await f.service.preview(actor, projectId, input());
  await assert.rejects(f.service.get({ userId: "other-user", platformRoles: ["user"] }, projectId, operation.id), code("REPOSITORY_CREATION_NOT_FOUND"));
  assert.deepEqual(await f.service.get(actor, projectId, operation.id), operation);
});

class RecordingDatabase implements DatabasePort {
  calls: { statement: string; parameters: readonly unknown[]; transaction: boolean }[] = [];
  responses: SqlResult<unknown>[] = [];
  transactionActive = false;
  committed = 0;
  rolledBack = 0;
  failPattern: RegExp | null = null;
  async query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ statement, parameters: clone(parameters), transaction: this.transactionActive });
    if (this.failPattern?.test(statement)) throw new Error("fixture database failed");
    return (this.responses.shift() ?? { rows: [], rowCount: 1 }) as SqlResult<Row>;
  }
  async transaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionActive = true;
    try { const value = await work(this); this.committed++; return value; } catch (error) { this.rolledBack++; throw error; } finally { this.transactionActive = false; }
  }
}
async function operationFixture() { const f = fixture(); return f.service.preview(actor, projectId, input()); }

test("PostgreSQL唯一project/user/key插入与审计同事务，持久化不包含token且读取限定归属", async () => {
  const database = new RecordingDatabase(); const operation = await operationFixture();
  database.responses = [{ rows: [{ payload: operation }], rowCount: 1 }];
  const store = new PostgresRepositoryCreationStore(database);
  assert.deepEqual(await store.insert(operation), operation);
  assert.match(database.calls[0].statement, /ON CONFLICT \(project_id,user_id,idempotency_key\)/);
  assert.match(database.calls[1].statement, /github_repository_creation_audit/);
  assert.ok(database.calls.every(call => call.transaction)); assert.equal(database.committed, 1);
  assert.ok(database.calls.every(call => !JSON.stringify(call.parameters).includes("fixture-server-token")));
  database.responses = [{ rows: [{ payload: JSON.stringify(operation) }], rowCount: 1 }, { rows: [{ payload: operation }], rowCount: 1 }];
  assert.deepEqual(await store.get(projectId, actor.userId, operation.id), operation);
  assert.deepEqual(await store.findByKey(projectId, actor.userId, operation.idempotencyKey), operation);
  assert.deepEqual(database.calls[2].parameters, [projectId, actor.userId, operation.id]);
  assert.deepEqual(database.calls[3].parameters, [projectId, actor.userId, operation.idempotencyKey]);
});

test("PostgreSQL重复幂等插入返回原operation，变更输入返回409且不重复审计", async () => {
  const operation = await operationFixture(); const database = new RecordingDatabase(); const store = new PostgresRepositoryCreationStore(database);
  database.responses = [{ rows: [], rowCount: 0 }, { rows: [{ payload: operation, input_hash: repositoryCreationInputHash(operation) }], rowCount: 1 }];
  assert.deepEqual(await store.insert({ ...operation, id: "new-generated-id", confirmationHash: "new-generated-hash" }), operation);
  assert.equal(database.calls.length, 2);
  database.responses = [{ rows: [], rowCount: 0 }, { rows: [{ payload: operation, input_hash: repositoryCreationInputHash(operation) }], rowCount: 1 }];
  await assert.rejects(store.insert({ ...operation, private: false }), code("IDEMPOTENCY_KEY_REUSED")); assert.equal(database.rolledBack, 1);
});

test("PostgreSQL CAS绑定输入哈希和project/user/id/version，冲突不写审计", async () => {
  const operation = await operationFixture(); const database = new RecordingDatabase(); const store = new PostgresRepositoryCreationStore(database);
  await store.update({ ...operation, revision: 2, status: "creating" }, 1);
  assert.match(database.calls[0].statement, /revision=\$6 AND input_hash=\$7/);
  assert.deepEqual(database.calls[0].parameters.slice(0, 4), [projectId, actor.userId, operation.id, 2]);
  assert.equal(database.calls[0].parameters[5], 1); assert.equal(database.calls[0].parameters[6], repositoryCreationInputHash(operation));
  assert.ok(database.calls.every(call => call.transaction));
  database.responses = [{ rows: [], rowCount: 0 }];
  const before = database.calls.length;
  await assert.rejects(store.update({ ...operation, revision: 3, status: "unknown" }, 2), code("VERSION_CONFLICT"));
  assert.equal(database.calls.length, before + 1); assert.equal(database.rolledBack, 1);
});

test("PostgreSQL审计失败回滚状态更新，避免无审计创建成功事实", async () => {
  const operation = await operationFixture(); const database = new RecordingDatabase(); database.failPattern = /INSERT INTO github_repository_creation_audit/;
  await assert.rejects(new PostgresRepositoryCreationStore(database).update({ ...operation, revision: 2, status: "created" }, 1), /fixture database failed/);
  assert.equal(database.committed, 0); assert.equal(database.rolledBack, 1);
});
