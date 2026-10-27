/**
 * 确认式执行的动作契约（纯校验，无 IO）。
 *
 * 模型可以提议一个动作，但：
 *  - kind 是**封闭集合**，白名单之外一律丢弃；
 *  - 字段长度有上限，超了就整条丢弃；
 *  - 解析失败返回 null，**不抛异常**（调用方只保留 reply）；
 *  - 这里不执行任何写操作：真正写入必须由人点确认后调用既有接口。
 */
export const AI_ACTION_KINDS = ["charter_fill", "plan_task", "team_note", "retro_entry"] as const;
export type AiActionKind = (typeof AI_ACTION_KINDS)[number];

/**
 * 每个动作只允许**对应专员**提出：越界一律拒绝。
 * 团队空间相关（框架卡、团队说明）只有团队空间助手可以提。
 */
export const ACTION_OWNERS: Readonly<Record<AiActionKind, readonly string[]>> = Object.freeze({
  charter_fill: ["space"],
  team_note: ["space"],
  plan_task: ["enroll", "teamup", "submit"],
  retro_entry: ["retro"],
});

export interface AiAction {
  readonly kind: AiActionKind;
  /** 提出这个动作的专员；必须是该动作允许的提出者。 */
  readonly specialist: string;
  readonly title: string;
  readonly dueAt?: string;
  readonly note?: string;
  /** 仅 charter_fill：AI 抽取出的框架卡四栏。 */
  readonly charter?: { readonly goal: string; readonly deliverables: readonly string[]; readonly nonGoals: readonly string[]; readonly timebox: string };
}

const TITLE_MAX = 120;
const NOTE_MAX = 600;

export function isAiActionKind(value: unknown): value is AiActionKind {
  return typeof value === "string" && (AI_ACTION_KINDS as readonly string[]).includes(value);
}

/** 只接受 ISO 时间或空；其它一律视作没有截止时间。 */
function dueAtOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

/**
 * 解析模型给出的 action。任何不合规都返回 null，绝不"猜一个"。
 */
export function parseAiAction(value: unknown): AiAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isAiActionKind(record.kind)) return null;
  const specialist = typeof record.specialist === "string" ? record.specialist : "";
  if (!ACTION_OWNERS[record.kind].includes(specialist)) return null;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (title === "" || title.length > TITLE_MAX) return null;
  const note = typeof record.note === "string" ? record.note.trim() : "";
  if (note.length > NOTE_MAX) return null;
  const dueAt = dueAtOf(record.dueAt);
  if (record.kind === "charter_fill") {
    const draft = parseCharterPayload(record.charter);
    if (draft === null) return null;
    return { kind: "charter_fill", specialist: "space", title, ...(draft === null ? {} : { charter: draft }) };
  }
  return {
    kind: record.kind,
    specialist,
    title,
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(note === "" ? {} : { note }),
  };
}

/** 给界面用的一句话描述；不改变语义，只做展示。 */
export function describeAiAction(action: AiAction): string {
  const base = action.kind === "plan_task" ? "创建任务" : action.kind === "team_note" ? "发团队说明" : "写复盘条目";
  const due = action.dueAt === undefined ? "" : "（截止 " + action.dueAt.slice(0, 16).replace("T", " ") + "）";
  return base + "：" + action.title + due;
}

/** 框架卡四栏的解析：任一栏不合规就整条丢弃，不做部分接受。 */
export function parseCharterPayload(value: unknown): { goal: string; deliverables: string[]; nonGoals: string[]; timebox: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const goal = typeof record.goal === "string" ? record.goal.trim() : "";
  if (goal === "" || goal.length > 400) return null;
  const list = (input: unknown): string[] | null => {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) return null;
    const items = input.map(item => (typeof item === "string" ? item.trim() : "")).filter(item => item !== "");
    if (items.length > 12 || items.some(item => item.length > 200)) return null;
    return items;
  };
  const deliverables = list(record.deliverables);
  const nonGoals = list(record.nonGoals);
  if (deliverables === null || nonGoals === null) return null;
  const timebox = typeof record.timebox === "string" ? record.timebox.trim().slice(0, 60) : "";
  return { goal, deliverables, nonGoals, timebox };
}
