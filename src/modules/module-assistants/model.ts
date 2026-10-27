import type { Actor } from "../../shared/contracts.ts";
import type { EventStaffCapability } from "../../shared/organizer-contracts.ts";

/** 计划 34 §2.1：7 个主办方流程模块各一个助手。key 与主办方 section 一一对应。 */
export const MODULE_ASSISTANT_KEYS = ["overview", "registration", "teams", "communication", "schedule", "services", "judging"] as const;
/** 规划 36：选手端 5 个环节各一个助手（报名 / 组队 / 提交 / 结果 / 复盘）。 */
export const PARTICIPANT_ASSISTANT_KEYS = ["enroll", "teamup", "submit", "results", "retro", "plan", "resources"] as const;
export const MODULE_ASSISTANT_AUDIENCES = ["staff", "participant"] as const;
export type ModuleAssistantAudience = (typeof MODULE_ASSISTANT_AUDIENCES)[number];
export const ALL_MODULE_ASSISTANT_KEYS = [...MODULE_ASSISTANT_KEYS, ...PARTICIPANT_ASSISTANT_KEYS] as const;
export type ModuleAssistantKey = typeof ALL_MODULE_ASSISTANT_KEYS[number];

/** 只允许产出草稿/清单/摘要/去重提示（宪法 XIII「模块专属助手」）。没有 publish/apply 一类的动作类型。 */
export const MODULE_ASSISTANT_OUTPUT_KINDS = ["draft", "checklist", "summary", "dedup_hint"] as const;
export type ModuleAssistantOutputKind = typeof MODULE_ASSISTANT_OUTPUT_KINDS[number];

export const MODULE_ASSISTANT_DEGRADE_REASONS = ["model_unavailable", "model_failed", "model_result_invalid", "ledger_unavailable", "sponsor_budget_exceeded"] as const;
export type ModuleAssistantDegradeReason = typeof MODULE_ASSISTANT_DEGRADE_REASONS[number];

/**
 * 注册表条目。声明这个助手是谁、需要哪一项既有 EventStaffCapability、能读哪些既有事实键、
 * 允许产出哪几类内容，以及它挂在哪个既有工作台页（绝不新增导航入口）。
 */
export interface ModuleAssistantRegistryEntry {
  readonly key: ModuleAssistantKey;
  readonly label: string;
  /** staff = 主办方工作人员；participant = 本场报名已通过的参赛者。 */
  readonly audience: ModuleAssistantAudience;
  /** 仅 staff：需要哪一项既有 EventStaffCapability。 */
  readonly requiredCapability?: EventStaffCapability;
  /** 仅 participant：必须具备的参赛状态。 */
  readonly requiredParticipant?: "approved";
  readonly readableFactKeys: readonly string[];
  readonly allowedOutputs: readonly ModuleAssistantOutputKind[];
  readonly sectionPath: string;
  readonly readsDescription: string;
}

export interface ModuleAssistantSource { readonly id: string; readonly label: string; readonly href?: string }

/** 注入的只读事实 Port 返回值。namespace 必须与本次调用计算出的独立命名空间一致。 */
export interface ModuleAssistantFacts {
  readonly moduleKey: ModuleAssistantKey;
  readonly organizationId: string;
  readonly eventId: string;
  readonly namespace: string;
  readonly capturedAt: string;
  readonly fingerprint: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly sources: readonly ModuleAssistantSource[];
  readonly missing: readonly string[];
}

/** 通过声明键校验后、真正送给模型的上下文；只有声明过的既有事实键。 */
export interface ModuleAssistantContext {
  readonly namespace: string;
  readonly namespaceLabel: string;
  readonly assistantKey: ModuleAssistantKey;
  readonly assistantLabel: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly actorUserId: string;
  readonly capturedAt: string;
  readonly fingerprint: string;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly sources: readonly ModuleAssistantSource[];
  readonly missing: readonly string[];
}

export interface ModuleAssistantOutputItem { readonly text: string; readonly sourceKeys: readonly string[] }
export interface ModuleAssistantOutput {
  readonly kind: ModuleAssistantOutputKind;
  readonly title: string;
  readonly body: string;
  readonly items: readonly ModuleAssistantOutputItem[];
  readonly notes: readonly string[];
  /** 服务端固定为 true：助手只出草稿，必须由人工显式复制或采用。 */
  readonly requiresHumanAction: true;
}

export interface ModuleAssistantReadScope {
  readonly factKeys: readonly string[];
  readonly sources: readonly ModuleAssistantSource[];
  readonly missing: readonly string[];
  readonly capturedAt: string;
  readonly fingerprint: string;
}
export interface ModuleAssistantTokenUsage { readonly inputTokens: number; readonly outputTokens: number }
export interface ModuleAssistantCost { readonly microUsdEstimated: number | null; readonly note: string }

/** 可展示的用量：谁、哪个模块、读了什么范围、花费，以及账本条目。 */
export interface ModuleAssistantUsage {
  readonly namespace: string;
  readonly namespaceLabel: string;
  readonly assistantKey: ModuleAssistantKey;
  readonly assistantLabel: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly readScope: ModuleAssistantReadScope;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly usage: ModuleAssistantTokenUsage | null;
  readonly cost: ModuleAssistantCost | null;
  readonly ledgerId: string | null;
  readonly recordedAt: string;
  /** 平台不设强制次数上限；赞助方自设额度由账本 Port 负责，避免静默限流。 */
  readonly platformCallLimit: null;
}

export interface ModuleAssistantDraftResult {
  readonly status: "draft";
  readonly draft: ModuleAssistantOutput;
  readonly usage: ModuleAssistantUsage;
  readonly disclaimer: string;
  readonly provider: "dsh";
}
export interface ModuleAssistantDegradedResult {
  readonly status: "degraded";
  readonly reason: ModuleAssistantDegradeReason;
  readonly message: string;
  readonly usage: ModuleAssistantUsage;
  readonly manualWorkflowUnaffected: true;
  readonly provider: "dsh";
}
export type ModuleAssistantRunResult = ModuleAssistantDraftResult | ModuleAssistantDegradedResult;

export interface ModuleAssistantRunInput {
  readonly assistantKey: ModuleAssistantKey;
  readonly eventId: string;
  readonly instruction: string;
  readonly expectedFingerprint?: string;
}

/** 注入的授权范围 Port（只读）。enabledAssistants 缺省表示全开（计划 34 §5.1：默认全开）。 */
export interface ModuleAssistantScope {
  readonly organizationId: string;
  readonly eventId: string;
  readonly capabilities: readonly EventStaffCapability[];
  /** 仅当调用者是本场报名已通过的参赛者时为 true；选手端助手据此放行。 */
  readonly participantApproved?: boolean;
  readonly enabledAssistants?: readonly ModuleAssistantKey[];
}
export interface ModuleAssistantFactsRequest {
  readonly actor: Actor;
  readonly organizationId: string;
  readonly eventId: string;
  readonly namespace: string;
}

export interface ModuleAssistantModelRequest {
  readonly namespace: string;
  readonly assistantKey: ModuleAssistantKey;
  readonly organizationId: string;
  readonly eventId: string;
  readonly systemPrompt: string;
  readonly promptVersion: string;
  readonly input: unknown;
  readonly outputExample: unknown;
  readonly maxOutputTokens: number;
}
export interface ModuleAssistantModelResult {
  readonly content: unknown;
  readonly usage: ModuleAssistantTokenUsage | null;
  readonly modelVersion: string;
  readonly requestId: string | null;
}

export interface ModuleAssistantLedgerEntry {
  readonly namespace: string;
  readonly namespaceLabel: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly assistantKey: ModuleAssistantKey;
  readonly assistantLabel: string;
  readonly actorUserId: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly readScope: ModuleAssistantReadScope;
  readonly outcome: "succeeded" | "degraded";
  readonly degradeReason: ModuleAssistantDegradeReason | null;
  readonly usage: ModuleAssistantTokenUsage | null;
  readonly providerRequestId: string | null;
  readonly errorCode: string | null;
  readonly occurredAt: string;
  readonly platformCallLimit: null;
}
export interface ModuleAssistantLedgerRecord {
  readonly ledgerId: string;
  readonly cost: ModuleAssistantCost | null;
}
