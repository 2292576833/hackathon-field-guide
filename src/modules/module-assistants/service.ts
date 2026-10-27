import { Buffer } from "node:buffer";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { moduleAssistantNamespace, moduleAssistantNamespaceLabel } from "./namespace.ts";
import {
  MODULE_ASSISTANT_DISCLAIMER, MODULE_ASSISTANT_OUTPUT_EXAMPLE, MODULE_ASSISTANT_PROMPT_VERSION,
  MODULE_ASSISTANT_SYSTEM_PROMPT, safeErrorCode, validateModuleAssistantFacts, validateModuleAssistantOutput,
} from "./prompt.ts";
import { isModuleAssistantKey, moduleAssistant, moduleAssistantCatalog } from "./registry.ts";
import type { ModuleAssistantDependencies } from "./ports.ts";
import type {
  ModuleAssistantContext, ModuleAssistantDegradeReason, ModuleAssistantDegradedResult, ModuleAssistantDraftResult,
  ModuleAssistantKey, ModuleAssistantLedgerEntry, ModuleAssistantLedgerRecord, ModuleAssistantModelResult,
  ModuleAssistantOutput, ModuleAssistantReadScope, ModuleAssistantRegistryEntry, ModuleAssistantRunInput,
  ModuleAssistantRunResult, ModuleAssistantScope, ModuleAssistantTokenUsage, ModuleAssistantUsage,
} from "./model.ts";

const INSTRUCTION_MAX_BYTES = 4_000;
const MAX_OUTPUT_TOKENS = 2_000;

interface CallBase {
  readonly entry: ModuleAssistantRegistryEntry;
  readonly namespace: string;
  readonly namespaceLabel: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly actorUserId: string;
  readonly readScope: ModuleAssistantReadScope;
  readonly modelVersion: string;
}

/**
 * 模块助手运行时。只做四件事：确认授权范围、读本模块声明的只读事实、请注入的模型 Port 生成草稿、把这次调用记进注入的账本。
 * 没有任何发布/发信/扣分/改结果/改权限路径，也不直接查库或接 DSH 网络调用。
 */
export function createModuleAssistantService(deps: ModuleAssistantDependencies) {
  function catalog(): readonly ModuleAssistantRegistryEntry[] { return moduleAssistantCatalog(); }

  async function resolveScope(actor: Actor, eventId: string): Promise<ModuleAssistantScope> {
    const scope = await deps.scope.resolve({ actor, eventId }).catch(() => { throw scopeInvalid(); });
    if (!scope || typeof scope.eventId !== "string" || scope.eventId !== eventId || typeof scope.organizationId !== "string"
      || !scope.organizationId.trim() || !Array.isArray(scope.capabilities) || !Array.isArray(scope.enabledAssistants ?? [])) throw scopeInvalid();
    return scope;
  }
  function scopeInvalid(): DomainError {
    return new DomainError("MODULE_ASSISTANT_SCOPE_INVALID", "暂时无法确认你在本场的授权，请刷新后重试。", { status: 503 });
  }
  function assertEnabled(scope: ModuleAssistantScope, entry: ModuleAssistantRegistryEntry): void {
    if (scope.enabledAssistants === undefined) return;
    if (!scope.enabledAssistants.includes(entry.key))
      throw new DomainError("MODULE_ASSISTANT_DISABLED", "本场主办方已关闭该模块助手；本模块的人工流程不受影响。", { status: 403 });
  }
  function assertCapability(scope: ModuleAssistantScope, entry: ModuleAssistantRegistryEntry): void {
    if (entry.audience === "participant") {
      if (scope.participantApproved !== true)
        throw new DomainError("MODULE_ASSISTANT_FORBIDDEN", "该助手只对本场报名已通过的参赛者开放。", { status: 403 });
      return;
    }
    const capability = entry.requiredCapability;
    if (capability === undefined || !scope.capabilities.includes(capability))
      throw new DomainError("MODULE_ASSISTANT_FORBIDDEN", "该助手只对拥有对应权限的本场工作人员开放。", { status: 403 });
  }

  async function writeLedger(call: CallBase, outcome: "succeeded" | "degraded", reason: ModuleAssistantDegradeReason | null, usage: ModuleAssistantTokenUsage | null, requestId: string | null, errorCode: string | null): Promise<ModuleAssistantLedgerRecord | null> {
    const entry: ModuleAssistantLedgerEntry = {
      namespace: call.namespace, namespaceLabel: call.namespaceLabel, organizationId: call.organizationId, eventId: call.eventId,
      assistantKey: call.entry.key, assistantLabel: call.entry.label, actorUserId: call.actorUserId,
      promptVersion: MODULE_ASSISTANT_PROMPT_VERSION, modelVersion: call.modelVersion, readScope: call.readScope,
      outcome, degradeReason: reason, usage, providerRequestId: requestId, errorCode, occurredAt: deps.clock.now().toISOString(), platformCallLimit: null,
    };
    try {
      const saved = await deps.ledger.record(entry);
      return saved && typeof saved.ledgerId === "string" && saved.ledgerId.trim() ? saved : null;
    } catch { return null; }
  }
  function buildUsage(call: CallBase, usage: ModuleAssistantTokenUsage | null, saved: ModuleAssistantLedgerRecord | null): ModuleAssistantUsage {
    return {
      namespace: call.namespace, namespaceLabel: call.namespaceLabel, assistantKey: call.entry.key, assistantLabel: call.entry.label,
      organizationId: call.organizationId, eventId: call.eventId, readScope: call.readScope, promptVersion: MODULE_ASSISTANT_PROMPT_VERSION,
      modelVersion: call.modelVersion, usage, cost: saved?.cost ?? null, ledgerId: saved?.ledgerId ?? null,
      recordedAt: deps.clock.now().toISOString(), platformCallLimit: null,
    };
  }
  /** 不可用/失败一律返回明确降级，不抛未处理异常，也不静默成功；人工流程照常可用。 */
  async function degrade(call: CallBase, reason: ModuleAssistantDegradeReason, message: string, usage: ModuleAssistantTokenUsage | null, requestId: string | null, errorCode: string | null): Promise<ModuleAssistantDegradedResult> {
    const saved = await writeLedger(call, "degraded", reason, usage, requestId, errorCode);
    return { status: "degraded", reason, message, usage: buildUsage(call, usage, saved), manualWorkflowUnaffected: true, provider: "dsh" };
  }

  async function run(actor: Actor, input: ModuleAssistantRunInput): Promise<ModuleAssistantRunResult> {
    if (!actor || typeof actor.userId !== "string" || !actor.userId.trim()) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
    if (!input || !isModuleAssistantKey(input.assistantKey)) throw new DomainError("MODULE_ASSISTANT_INVALID_INPUT", "请选择本场要使用的模块助手。", { status: 422 });
    const eventId = requiredText(input.eventId, 200, "赛事");
    const instruction = requiredText(input.instruction, INSTRUCTION_MAX_BYTES, "要求");
    const entry = moduleAssistant(input.assistantKey);

    const scope = await resolveScope(actor, eventId);
    assertEnabled(scope, entry);
    assertCapability(scope, entry);

    const namespace = moduleAssistantNamespace({ organizationId: scope.organizationId, eventId, assistantKey: entry.key, userId: actor.userId });
    const namespaceLabel = moduleAssistantNamespaceLabel({ organizationId: scope.organizationId, eventId, assistantKey: entry.key, userId: actor.userId }, entry.label);
    const readFacts = deps.facts[entry.key];
    if (readFacts === undefined) throw new DomainError("MODULE_ASSISTANT_NOT_WIRED", "这个环节的助手还没有接入只读事实；不影响你照常办理。", { status: 503 });
    const facts = await readFacts({ actor, organizationId: scope.organizationId, eventId, namespace })
      .catch(() => { throw new DomainError("MODULE_ASSISTANT_CONTEXT_INVALID", "本模块的只读事实暂时无法安全读取，未发送给模型。", { status: 503 }); });
    const boundedFacts = validateModuleAssistantFacts(facts, entry, { namespace, eventId, organizationId: scope.organizationId });
    if (input.expectedFingerprint !== undefined && input.expectedFingerprint !== facts.fingerprint)
      throw new DomainError("MODULE_ASSISTANT_CONTEXT_CHANGED", "本模块事实已变化，请先刷新后再让助手生成草稿。", { status: 409 });

    const readScope: ModuleAssistantReadScope = { factKeys: Object.keys(boundedFacts), sources: facts.sources, missing: facts.missing, capturedAt: facts.capturedAt, fingerprint: facts.fingerprint };
    const context: ModuleAssistantContext = {
      namespace, namespaceLabel, assistantKey: entry.key, assistantLabel: entry.label, organizationId: scope.organizationId,
      eventId, actorUserId: actor.userId, capturedAt: facts.capturedAt, fingerprint: facts.fingerprint,
      facts: boundedFacts, sources: facts.sources, missing: facts.missing,
    };
    const call: CallBase = { entry, namespace, namespaceLabel, organizationId: scope.organizationId, eventId, actorUserId: actor.userId, readScope, modelVersion: deps.model.modelVersion };

    if (!deps.model.available) return degrade(call, "model_unavailable", "模型当前不可用，未生成草稿；本模块的人工流程照常可用。", null, null, "MODULE_ASSISTANT_MODEL_UNAVAILABLE");

    let result: ModuleAssistantModelResult;
    try {
      result = await deps.model.complete({
        namespace, assistantKey: entry.key, organizationId: scope.organizationId, eventId,
        systemPrompt: MODULE_ASSISTANT_SYSTEM_PROMPT, promptVersion: MODULE_ASSISTANT_PROMPT_VERSION,
        input: {
          assistantKey: entry.key, moduleLabel: entry.label, readsDescription: entry.readsDescription,
          event: { eventId, organizationId: scope.organizationId }, namespace, instruction,
          facts: boundedFacts, sources: facts.sources, missing: facts.missing,
          declaredFactKeys: entry.readableFactKeys, allowedOutputs: entry.allowedOutputs,
        },
        outputExample: MODULE_ASSISTANT_OUTPUT_EXAMPLE, maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
    } catch (error) {
      const code = safeErrorCode(error);
      if (code === "AI_BUDGET_EXCEEDED")
        return degrade(call, "sponsor_budget_exceeded", "主办方为本场显式设置的助手额度已用完；平台不设强制次数上限，也不静默降级，人工流程照常可用。", null, null, code);
      return degrade(call, "model_failed", "模型这次没有返回可用结果，未生成草稿；本模块的人工流程照常可用，可稍后明确重试。", null, null, code);
    }

    const finalCall: CallBase = { ...call, modelVersion: typeof result.modelVersion === "string" && result.modelVersion.trim() ? result.modelVersion : call.modelVersion };
    let draft: ModuleAssistantOutput;
    try { draft = validateModuleAssistantOutput(result.content, entry); }
    catch { return degrade(finalCall, "model_result_invalid", "助手返回的内容未通过草稿与依据检查，未作为可用草稿展示，也未据此改动任何业务状态。", normalizeUsage(result.usage), result.requestId, "MODULE_ASSISTANT_OUTPUT_INVALID"); }

    const saved = await writeLedger(finalCall, "succeeded", null, normalizeUsage(result.usage), result.requestId, null);
    if (!saved)
      return degrade(finalCall, "ledger_unavailable", "本次调用没有记账成功，因此不展示该草稿——AI 产出必须可核对。请稍后重试或继续人工处理。", normalizeUsage(result.usage), result.requestId, "MODULE_ASSISTANT_LEDGER_UNAVAILABLE");
    const draftResult: ModuleAssistantDraftResult = { status: "draft", draft, usage: buildUsage(finalCall, normalizeUsage(result.usage), saved), disclaimer: MODULE_ASSISTANT_DISCLAIMER, provider: "dsh" };
    return draftResult;
  }

  return { catalog, run };
}
export type ModuleAssistantService = ReturnType<typeof createModuleAssistantService>;
export type { ModuleAssistantKey };

function requiredText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\u0000"))
    throw new DomainError("MODULE_ASSISTANT_INVALID_INPUT", `请填写有效的${label}内容，并缩短过长的输入。`, { status: 422 });
  return value.trim();
}
function normalizeUsage(value: unknown): ModuleAssistantTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown };
  const inputTokens = usage.inputTokens, outputTokens = usage.outputTokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || (inputTokens as number) < 0 || (outputTokens as number) < 0 || (inputTokens as number) > 1_000_000_000 || (outputTokens as number) > 1_000_000_000) return null;
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
}
