import { DomainError } from "../../shared/errors.ts";
import type { ModuleAssistantKey } from "./model.ts";

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/;

function reference(value: unknown, label: string): string {
  if (typeof value !== "string" || !REFERENCE.test(value)) throw new DomainError("MODULE_ASSISTANT_SCOPE_INVALID", `${label}标识无效，暂时无法确认本模块助手的作用范围。`, { status: 503 });
  return value;
}

export interface ModuleAssistantNamespaceInput {
  readonly organizationId: string;
  readonly eventId: string;
  readonly assistantKey: ModuleAssistantKey;
  readonly userId: string;
}

/**
 * 显式独立命名空间：机构 + 赛事 + 模块 + 账号。
 * 选手备赛 AI、全站聊天、团队助手各有自己的命名空间，互不继承记忆/检索/缓存/队列（宪法 XIII 与 XI 同一条）。
 */
export function moduleAssistantNamespace(input: ModuleAssistantNamespaceInput): string {
  return `org:${reference(input.organizationId, "机构")}:event:${reference(input.eventId, "赛事")}:module:${input.assistantKey}:user:${reference(input.userId, "账号")}`;
}

/** 给主办方看的命名空间说明，明确它只覆盖这一场、这一个模块、这一个账号。 */
export function moduleAssistantNamespaceLabel(input: ModuleAssistantNamespaceInput, assistantLabel: string, organizationName?: string): string {
  const organization = organizationName && organizationName.trim() ? organizationName.trim() : input.organizationId;
  return `机构 ${organization} · 赛事 ${input.eventId} · 模块 ${assistantLabel} · 账号 ${input.userId}`;
}
