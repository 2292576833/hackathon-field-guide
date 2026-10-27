import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { EVENT_STAFF_CAPABILITIES, type EventStaffCapability } from "../../shared/organizer-contracts.ts";
import { MODULE_ASSISTANT_KEYS, type ModuleAssistantFacts, type ModuleAssistantFactsRequest, type ModuleAssistantKey, type ModuleAssistantLedgerEntry, type ModuleAssistantLedgerRecord, type ModuleAssistantModelRequest, type ModuleAssistantModelResult, type ModuleAssistantScope } from "./model.ts";
import type { ModuleAssistantFactsPort, ModuleAssistantLedgerPort, ModuleAssistantModelPort, ModuleAssistantScopePort } from "./ports.ts";
import { moduleAssistant } from "./registry.ts";
import { createModuleAssistantService } from "./service.ts";

const ACTOR: Actor = { userId: "staff-1", platformRoles: ["user"] };
const ACTOR_TWO: Actor = { userId: "staff-2", platformRoles: ["user"] };
const READ_AT = "2026-10-16T10:00:00.000Z";
const CAPTURED_AT = "2026-10-16T09:00:00.000Z";
const ALL_CAPABILITIES = [...EVENT_STAFF_CAPABILITIES];
const ENTRY_KEYS = ["kind", "title", "body", "items", "notes", "requiresHumanAction"].sort();

interface FixtureOptions {
  capabilities?: readonly EventStaffCapability[];
  enabledAssistants?: readonly ModuleAssistantKey[];
  scope?: (actor: Actor, eventId: string) => ModuleAssistantScope;
  facts?: Partial<Record<ModuleAssistantKey, (request: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>>>;
  model?: (request: ModuleAssistantModelRequest) => Promise<ModuleAssistantModelResult>;
  modelAvailable?: boolean;
  ledger?: (entry: ModuleAssistantLedgerEntry) => Promise<ModuleAssistantLedgerRecord>;
}

function fixture(options: FixtureOptions = {}) {
  const calls = { scope: 0, facts: {} as Record<string, number>, models: [] as ModuleAssistantModelRequest[], ledger: [] as ModuleAssistantLedgerEntry[] };
  const scopePort: ModuleAssistantScopePort = {
    async resolve({ actor, eventId }) {
      calls.scope += 1;
      if (options.scope) return options.scope(actor, eventId);
      return { organizationId: "org-1", eventId, capabilities: options.capabilities ?? ALL_CAPABILITIES, enabledAssistants: options.enabledAssistants };
    },
  };
  const read = async (key: ModuleAssistantKey, request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> => {
    calls.facts[key] = (calls.facts[key] ?? 0) + 1;
    const override = options.facts?.[key];
    if (override) return override(request);
    const entry = moduleAssistant(key);
    return {
      moduleKey: key, organizationId: request.organizationId, eventId: request.eventId, namespace: request.namespace,
      capturedAt: CAPTURED_AT, fingerprint: `fp:${key}`,
      values: { [entry.readableFactKeys[0]]: 3 },
      sources: [{ id: "src-1", label: "本场既有记录" }], missing: [],
    };
  };
  const factsPort: ModuleAssistantFactsPort = {
    overview: request => read("overview", request), registration: request => read("registration", request),
    teams: request => read("teams", request), communication: request => read("communication", request),
    schedule: request => read("schedule", request), services: request => read("services", request), judging: request => read("judging", request),
  };
  const modelPort: ModuleAssistantModelPort = {
    available: options.modelAvailable ?? true,
    modelVersion: "dsh-test",
    async complete(request) {
      calls.models.push(request);
      if (options.model) return options.model(request);
      const entry = moduleAssistant(request.assistantKey);
      return {
        content: { kind: "summary", title: "本场摘要", body: "按输入事实汇总，供人工核对。", items: [{ text: "引用输入事实", sourceKeys: [entry.readableFactKeys[0]] }], notes: ["仅汇总输入事实。"] },
        usage: { inputTokens: 100, outputTokens: 20 }, modelVersion: "dsh-test", requestId: "req-1",
      };
    },
  };
  const ledgerPort: ModuleAssistantLedgerPort = {
    async record(entry) {
      calls.ledger.push(entry);
      if (options.ledger) return options.ledger(entry);
      return { ledgerId: `ledger-${calls.ledger.length}`, cost: { microUsdEstimated: 12, note: "按账本费率估算" } };
    },
  };
  const service = createModuleAssistantService({ scope: scopePort, facts: factsPort, model: modelPort, ledger: ledgerPort, clock: { now: () => new Date(READ_AT) } });
  return { service, calls };
}

const RUN = (key: ModuleAssistantKey, eventId = "evt-1", instruction = "整理本场下一步") => ({ assistantKey: key, eventId, instruction });

test("只把注册表声明的既有事实键送进模型，并把只读范围写进用量与账本", async () => {
  const { service, calls } = fixture();
  const result = await service.run(ACTOR, RUN("registration"));
  assert.equal(result.status, "draft");
  assert.equal(calls.models.length, 1);
  const input = calls.models[0].input as { facts: Record<string, unknown>; declaredFactKeys: readonly string[]; allowedOutputs: readonly string[] };
  assert.deepEqual(Object.keys(input.facts), ["pendingReviewCount"]);
  assert.deepEqual(input.declaredFactKeys, moduleAssistant("registration").readableFactKeys);
  assert.deepEqual(input.allowedOutputs, ["summary", "checklist", "draft", "dedup_hint"]);
  assert.deepEqual(result.usage.readScope.factKeys, ["pendingReviewCount"]);
  assert.equal(result.usage.readScope.fingerprint, "fp:registration");
  assert.equal(result.usage.readScope.capturedAt, CAPTURED_AT);
  if (result.status !== "draft") throw new Error("expected draft");
  assert.equal(result.usage.ledgerId, "ledger-1");
  assert.equal(result.usage.cost?.microUsdEstimated, 12);
  assert.equal(result.usage.platformCallLimit, null);
  assert.equal(result.provider, "dsh");
});

test("只读事实出现未声明键、或命名空间/赛事不一致时被拒绝，且不发送给模型", async () => {
  const extra = fixture({ facts: { registration: async request => ({ moduleKey: "registration", organizationId: request.organizationId, eventId: request.eventId, namespace: request.namespace, capturedAt: CAPTURED_AT, fingerprint: "fp:registration", values: { pendingReviewCount: 2, peerComments: ["不该出现"] }, sources: [], missing: [] }) } });
  await assert.rejects(extra.service.run(ACTOR, RUN("registration")), (error: unknown) => error instanceof DomainError && error.code === "MODULE_ASSISTANT_CONTEXT_INVALID");
  assert.equal(extra.calls.models.length, 0);
  assert.equal(extra.calls.ledger.length, 0);

  const wrongNamespace = fixture({ facts: { registration: async request => ({ moduleKey: "registration", organizationId: request.organizationId, eventId: request.eventId, namespace: "org:other:event:other:module:registration:user:someone", capturedAt: CAPTURED_AT, fingerprint: "fp:registration", values: { pendingReviewCount: 2 }, sources: [], missing: [] }) } });
  await assert.rejects(wrongNamespace.service.run(ACTOR, RUN("registration")), (error: unknown) => error instanceof DomainError && error.code === "MODULE_ASSISTANT_CONTEXT_INVALID");

  const wrongKey = fixture({ facts: { registration: async request => ({ moduleKey: "judging", organizationId: request.organizationId, eventId: request.eventId, namespace: request.namespace, capturedAt: CAPTURED_AT, fingerprint: "fp:judging", values: { pendingReviewCount: 2 }, sources: [], missing: [] }) } });
  await assert.rejects(wrongKey.service.run(ACTOR, RUN("registration")), (error: unknown) => error instanceof DomainError && error.code === "MODULE_ASSISTANT_CONTEXT_INVALID");
  assert.equal(wrongKey.calls.models.length, 0);
});

test("越权模块不可用：能力不匹配时在读事实之前就拒绝，且不记账", async () => {
  const { service, calls } = fixture({ capabilities: ["registration_manage"] });
  await assert.rejects(service.run(ACTOR, RUN("judging")), (error: unknown) => error instanceof DomainError && error.code === "MODULE_ASSISTANT_FORBIDDEN" && error.status === 403);
  assert.equal(calls.facts.judging ?? 0, 0);
  assert.equal(calls.models.length, 0);
  assert.equal(calls.ledger.length, 0);
});

test("本场关闭某模块助手时不可用，人工流程照常（不读事实、不调用模型）", async () => {
  const { service, calls } = fixture({ enabledAssistants: ["registration"] });
  await assert.rejects(service.run(ACTOR, RUN("judging")), (error: unknown) => error instanceof DomainError && error.code === "MODULE_ASSISTANT_DISABLED");
  assert.equal(calls.facts.judging ?? 0, 0);
  assert.equal(calls.models.length, 0);
  assert.equal(moduleAssistant("judging").key, "judging");
});

test("产出只有草稿：允许的类型之外、或带动作字段的输出一律不展示", async () => {
  const { service } = fixture();
  const result = await service.run(ACTOR, RUN("registration"));
  if (result.status !== "draft") throw new Error("expected draft");
  assert.deepEqual(Object.keys(result.draft).sort(), ENTRY_KEYS);
  assert.equal(result.draft.requiresHumanAction, true);
  assert.equal(result.draft.kind, "summary");
  assert.doesNotMatch(JSON.stringify(result), /"(publish|apply|send|deduct|grant|revoke|delete|insert|update)"/i);

  const publishing = fixture({ model: async () => ({ content: { kind: "publish", title: "直接发布", body: "发布所有结果", items: [], notes: [] }, usage: null, modelVersion: "dsh-test", requestId: "r2" }) });
  const published = await publishing.service.run(ACTOR, RUN("registration"));
  assert.equal(published.status, "degraded");
  if (published.status === "degraded") assert.equal(published.reason, "model_result_invalid");

  const actionField = fixture({ model: async () => ({ content: { kind: "draft", title: "草稿", body: "草稿正文", items: [], notes: [], approve: true }, usage: null, modelVersion: "dsh-test", requestId: "r3" }) });
  const withAction = await actionField.service.run(ACTOR, RUN("registration"));
  assert.equal(withAction.status, "degraded");

  const badSource = fixture({ model: async () => ({ content: { kind: "checklist", title: "清单", body: "正文", items: [{ text: "项", sourceKeys: ["peerComments"] }], notes: [] }, usage: null, modelVersion: "dsh-test", requestId: "r4" }) });
  assert.equal((await badSource.service.run(ACTOR, RUN("registration"))).status, "degraded");
});

test("每次调用都被记账：谁、哪个模块、读了什么范围、花费", async () => {
  const { service, calls } = fixture();
  const result = await service.run(ACTOR, RUN("judging"));
  assert.equal(calls.ledger.length, 1);
  const entry = calls.ledger[0];
  assert.equal(entry.actorUserId, "staff-1");
  assert.equal(entry.assistantKey, "judging");
  assert.equal(entry.organizationId, "org-1");
  assert.equal(entry.eventId, "evt-1");
  assert.deepEqual(entry.readScope.factKeys, ["receiptCount"]);
  assert.deepEqual(entry.readScope.sources, [{ id: "src-1", label: "本场既有记录" }]);
  assert.equal(entry.outcome, "succeeded");
  assert.equal(entry.usage?.outputTokens, 20);
  assert.equal(entry.occurredAt, READ_AT);
  assert.equal(entry.platformCallLimit, null);
  assert.match(entry.namespaceLabel, /模块 收件与评审/);
  if (result.status !== "draft") throw new Error("expected draft");
  assert.equal(result.usage.ledgerId, "ledger-1");
});

test("模型不可用/失败/额度用尽都返回明确降级，不抛未处理异常，人工流程不受影响", async () => {
  const unavailable = fixture({ modelAvailable: false });
  const first = await unavailable.service.run(ACTOR, RUN("registration"));
  assert.equal(first.status, "degraded");
  if (first.status === "degraded") { assert.equal(first.reason, "model_unavailable"); assert.equal(first.manualWorkflowUnaffected, true); }
  assert.equal(unavailable.calls.models.length, 0);
  assert.equal(unavailable.calls.ledger.length, 1);
  assert.equal(unavailable.calls.ledger[0].outcome, "degraded");

  const failing = fixture({ model: async () => { throw new Error("provider blew up: secret body"); } });
  const second = await failing.service.run(ACTOR, RUN("registration"));
  assert.equal(second.status, "degraded");
  if (second.status === "degraded") assert.equal(second.reason, "model_failed");
  assert.doesNotMatch(JSON.stringify(second), /secret body/);
  assert.equal(failing.calls.ledger.length, 1);

  const budget = fixture({ model: async () => { throw new DomainError("AI_BUDGET_EXCEEDED", "额度已用完", { status: 429 }); } });
  const third = await budget.service.run(ACTOR, RUN("registration"));
  assert.equal(third.status, "degraded");
  if (third.status === "degraded") assert.equal(third.reason, "sponsor_budget_exceeded");
});

test("记账失败时不展示草稿（AI 产出必须可核对），返回降级而不是异常", async () => {
  const { service, calls } = fixture({ ledger: async () => { throw new Error("ledger down"); } });
  const result = await service.run(ACTOR, RUN("registration"));
  assert.equal(result.status, "degraded");
  if (result.status === "degraded") assert.equal(result.reason, "ledger_unavailable");
  assert.equal("draft" in result, false);
  assert.equal(calls.ledger.length, 2);
});

test("不限次数：连续 50 次调用全部到达模型并各自记账，平台不设强制上限", async () => {
  const { service, calls } = fixture();
  for (let index = 0; index < 50; index += 1) {
    const result = await service.run(ACTOR, RUN("teams", "evt-1", `第 ${index} 次整理`));
    assert.equal(result.status, "draft");
  }
  assert.equal(calls.models.length, 50);
  assert.equal(calls.ledger.length, 50);
  assert.equal(calls.facts.teams, 50);
  for (const entry of calls.ledger) assert.equal(entry.platformCallLimit, null);
});

test("独立上下文：机构+赛事+模块+账号不同的两次调用命名空间不同，且事实不共享", async () => {
  const { service, calls } = fixture({
    scope: (actor, eventId) => ({ organizationId: eventId === "evt-1" ? "org-1" : "org-2", eventId, capabilities: ALL_CAPABILITIES }),
    facts: {
      registration: async request => ({ moduleKey: "registration", organizationId: request.organizationId, eventId: request.eventId, namespace: request.namespace, capturedAt: CAPTURED_AT, fingerprint: "fp:registration", values: { pendingReviewCount: 2 }, sources: [], missing: [] }),
      judging: async request => ({ moduleKey: "judging", organizationId: request.organizationId, eventId: request.eventId, namespace: request.namespace, capturedAt: CAPTURED_AT, fingerprint: "fp:judging", values: { receiptCount: 9 }, sources: [], missing: [] }),
    },
  });
  await service.run(ACTOR, RUN("registration", "evt-1"));
  await service.run(ACTOR_TWO, RUN("judging", "evt-2"));
  assert.equal(calls.models[0].namespace, "org:org-1:event:evt-1:module:registration:user:staff-1");
  assert.equal(calls.models[1].namespace, "org:org-2:event:evt-2:module:judging:user:staff-2");
  assert.notEqual(calls.models[0].namespace, calls.models[1].namespace);
  assert.deepEqual(Object.keys((calls.models[0].input as { facts: Record<string, unknown> }).facts), ["pendingReviewCount"]);
  assert.deepEqual(Object.keys((calls.models[1].input as { facts: Record<string, unknown> }).facts), ["receiptCount"]);
  assert.equal(calls.ledger[0].namespace, calls.models[0].namespace);
  assert.equal(calls.ledger[1].namespace, calls.models[1].namespace);
});

test("已读取的事实发生变化时拒绝复用旧草稿（指纹不一致 409）", async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.run(ACTOR, { ...RUN("registration"), expectedFingerprint: "fp:old" }), (error: unknown) => error instanceof DomainError && error.code === "MODULE_ASSISTANT_CONTEXT_CHANGED" && error.status === 409);
  assert.equal(calls.models.length, 0);
});

test("不存在的助手 key 与空要求被明确拒绝", async () => {
  const { service } = fixture();
  await assert.rejects(service.run(ACTOR, { assistantKey: "publish" as ModuleAssistantKey, eventId: "evt-1", instruction: "x" }), (error: unknown) => error instanceof DomainError && error.code === "MODULE_ASSISTANT_INVALID_INPUT");
  await assert.rejects(service.run(ACTOR, { assistantKey: "registration", eventId: "evt-1", instruction: "   " }), (error: unknown) => error instanceof DomainError && error.code === "MODULE_ASSISTANT_INVALID_INPUT");
  await assert.rejects(service.run({ userId: "", platformRoles: [] }, RUN("registration")), (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED");
});

test("没有写路径：服务只调用声明的 Port 方法，且源码里不存在 SQL/业务写调用或全局缓存", async () => {
  const guarded = <T extends object>(target: T, label: string): T => new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && !(property in object)) throw new Error(`${label} 触发了未声明的写路径：${property}`);
      return Reflect.get(object, property, receiver);
    },
  }) as T;
  const { service, calls } = fixture();
  const probe = createModuleAssistantService({
    scope: guarded({ resolve: async () => ({ organizationId: "org-1", eventId: "evt-1", capabilities: ALL_CAPABILITIES }) }, "scope"),
    facts: guarded({
      overview: async () => { throw new Error("unused"); }, registration: async request => ({ moduleKey: "registration", organizationId: request.organizationId, eventId: request.eventId, namespace: request.namespace, capturedAt: CAPTURED_AT, fingerprint: "fp:registration", values: { pendingReviewCount: 1 }, sources: [], missing: [] }),
      teams: async () => { throw new Error("unused"); }, communication: async () => { throw new Error("unused"); },
      schedule: async () => { throw new Error("unused"); }, services: async () => { throw new Error("unused"); }, judging: async () => { throw new Error("unused"); },
    }, "facts"),
    model: guarded({ available: true, modelVersion: "dsh-test", complete: async () => ({ content: { kind: "summary", title: "摘要", body: "正文", items: [], notes: [] }, usage: null, modelVersion: "dsh-test", requestId: null }) }, "model"),
    ledger: guarded({ record: async () => ({ ledgerId: "ledger-x", cost: null }) }, "ledger"),
    clock: { now: () => new Date(READ_AT) },
  });
  assert.equal((await probe.run(ACTOR, RUN("registration"))).status, "draft");
  assert.equal(calls.models.length, 0);

  const writeWords = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i;
  const writeCalls = /\.(insert|update|delete|publish|send|deduct|grant|revoke)\s*\(/;
  const globalState = /globalThis|process\.env|new Map\(|new Set\(/;
  for (const file of ["./service.ts", "./registry.ts", "./ports.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, writeWords, `${file} 不得包含 SQL 写动词`);
    assert.doesNotMatch(source, writeCalls, `${file} 不得调用写方法`);
    assert.doesNotMatch(source, globalState, `${file} 不得有全局状态或共享缓存`);
  }
  assert.equal(MODULE_ASSISTANT_KEYS.length, 7);
});
