import type { EntityId, Instant } from "../../shared/contracts.ts";
import type { IntakeReceipt, WorkDisclosure, WorkDisclosureFields, WorkDisclosureScope, WorkShowcaseEntry, WorkShowcaseFieldKey, MyWorkDisclosure } from "./model.ts";
import { invalid, text } from "./validation.ts";

/**
 * 规划 34 C①「作品展示（队伍可选公开）」的**全部业务判断**（纯函数，无 IO、无 `Date.now()`）。
 *
 * 本文件只做三件事：
 * 1. 校验队伍提交的公开范围与逐项字段选择；
 * 2. 把"队伍主动选择公开的披露记录 + 该队最新正式收件材料"投影成**只读公开条目**；
 * 3. 固定界面必须逐字使用的隐私口径（默认不公开、只显示勾选项、可随时撤回）。
 *
 * 它不做：评分、排名、名次、公布、点评、通知、任何写入。
 * 它**不能**读到联系人、邮箱、答卷、求助、住宿、队伍专属反馈或评委身份——
 * 投影函数的输入类型只有 `IntakeReceipt.materials`（名称/简介/链接/文件元数据）
 * 与披露记录本身，因此上述内容结构上无法进入公开面。
 */

export const workDisclosureScopes: readonly WorkDisclosureScope[] = ["private", "participants", "public"];
export const workShowcaseFieldKeys: readonly WorkShowcaseFieldKey[] = ["title", "description", "links", "files"];
export const workShowcaseScopeNames: Record<Exclude<WorkDisclosureScope, "private">, string> = { participants: "仅本场参赛者", public: "公开（含访客）" };
export const workDisclosureScopeNames: Record<WorkDisclosureScope, string> = { private: "不公开（默认）", ...workShowcaseScopeNames };

export const workDisclosureNotices = {
  defaultPrivate: "默认不公开：你们队不提交这项选择，作品不会出现在任何作品展示里。",
  fieldChoice: "作品展示只显示你们勾选公开的内容；联系人、邮箱、答卷、求助、住宿、队伍专属反馈与评委身份永不公开，也没有进入这项展示的读取范围。",
  scope: "「仅本场参赛者」只对本场报名已通过的选手显示；「公开（含访客）」未登录访客也能看到。两者都不改变分数、名次与公布。",
  withdraw: "你可以随时撤回这条选择；撤回后作品立即从展示中消失，撤回之后仍可重新提交。",
  gate: "作品展示由本场主办方开启；未开启时既不能提交这项选择，也不会返回任何作品。",
} as const;

/** 公开范围必须是三选一的明确值；不接受空值或"默认"。 */
export function workDisclosureScope(value: unknown): WorkDisclosureScope {
  const scope = typeof value === "string" ? value : "";
  if (!(workDisclosureScopes as readonly string[]).includes(scope)) invalid("请选择不公开、仅本场参赛者或公开。");
  return scope as WorkDisclosureScope;
}

/**
 * 逐项字段选择。未勾选即不公开；未知键直接拒绝（不静默丢弃）。
 * `private`（不公开）时不保留任何字段选择——范围本身已经表示什么都不公开。
 */
export function workDisclosureFields(value: unknown, scope: WorkDisclosureScope): WorkDisclosureFields {
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) invalid("公开内容格式不正确。");
  const raw = (value ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!(workShowcaseFieldKeys as readonly string[]).includes(key)) invalid("公开内容只能逐项选择作品名称、简介、链接和文件。");
  for (const key of workShowcaseFieldKeys) if (raw[key] !== undefined && typeof raw[key] !== "boolean") invalid("公开内容每一项只能是是或否。");
  const fields: WorkDisclosureFields = { title: raw.title === true, description: raw.description === true, links: raw.links === true, files: raw.files === true };
  return scope === "private" ? { title: false, description: false, links: false, files: false } : fields;
}

export function workDisclosureTeamId(value: unknown): string { return text(value, "队伍", 160); }
export function workDisclosureId(value: unknown): string { return text(value, "公开范围记录", 160); }
export function workDisclosureIdempotencyKey(value: unknown): string { return text(value, "重试标识", 120); }
export function workDisclosureRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid("预期版本必须是正整数。");
  return value;
}

/** 同一队伍的"有效（未撤回）"记录最多一条；数据库部分唯一索引是最终保证。 */
export function activeWorkDisclosure(records: readonly WorkDisclosure[], teamId: EntityId): WorkDisclosure | null {
  return records.find(record => record.teamId === teamId && record.status === "active") ?? null;
}

/** 是否同一个选择：范围 + 逐项字段完全一致。用于"重复提交同样的选择"不产生历史噪音。 */
export function sameWorkDisclosureChoice(left: Pick<WorkDisclosure, "scope" | "fields">, right: Pick<WorkDisclosure, "scope" | "fields">): boolean {
  return left.scope === right.scope
    && workShowcaseFieldKeys.every(key => left.fields[key] === right.fields[key]);
}

export function disclosedFieldKeys(fields: WorkDisclosureFields): readonly WorkShowcaseFieldKey[] {
  return workShowcaseFieldKeys.filter(key => fields[key] === true);
}

/** 队伍最新一版正式收件回执：版本号最大；同版本按提交时间、id 倒序保证顺序确定。 */
export function latestReceiptOf(receipts: readonly IntakeReceipt[], teamId: EntityId): IntakeReceipt | null {
  const own = receipts.filter(receipt => receipt.teamId === teamId);
  if (!own.length) return null;
  return [...own].sort((left, right) =>
    right.version - left.version
    || (left.submittedAt < right.submittedAt ? 1 : left.submittedAt > right.submittedAt ? -1 : 0)
    || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))[0]!;
}

/**
 * 单条公开投影：**只放队伍勾选公开的字段**，未勾选的键整体缺失。
 * 内部标识（回执 id / 版本号）、哈希与服务端字段一律不进投影。
 */
export function workShowcaseEntry(disclosure: WorkDisclosure, receipt: IntakeReceipt): WorkShowcaseEntry | null {
  if (disclosure.scope === "private") return null;
  const fields = disclosure.fields, materials = receipt.materials;
  return {
    teamId: disclosure.teamId,
    snapshotId: receipt.id,
    scope: disclosure.scope,
    disclosedFields: disclosedFieldKeys(fields),
    updatedAt: disclosure.updatedAt,
    ...(fields.title ? { title: materials.title } : {}),
    ...(fields.description ? { description: materials.description } : {}),
    ...(fields.links ? { links: materials.links.map(link => ({ label: link.label, url: link.url })) } : {}),
    ...(fields.files ? { files: materials.files.map(file => ({ name: file.name, url: file.url, sizeBytes: file.sizeBytes, sha256: file.sha256, mediaType: file.mediaType })) } : {}),
  };
}

/**
 * 只读列表投影。
 *
 * - 只列 `status === "active"` 且范围不是 `private` 的披露记录；
 * - `participants` 只对"观看者本场报名已通过"时出现，`public` 对所有人出现；
 * - 没有正式收件的队伍不出现（没有可展示的作品）；
 * - 顺序按队伍标识稳定排序，不按分数、名次或提交时间。
 */
export function workShowcaseEntries(input: {
  readonly receipts: readonly IntakeReceipt[];
  readonly disclosures: readonly WorkDisclosure[];
  readonly viewerIsParticipant: boolean;
}): readonly WorkShowcaseEntry[] {
  const entries: WorkShowcaseEntry[] = [];
  for (const disclosure of input.disclosures) {
    if (disclosure.status !== "active" || disclosure.scope === "private") continue;
    if (disclosure.scope === "participants" && !input.viewerIsParticipant) continue;
    const receipt = latestReceiptOf(input.receipts, disclosure.teamId);
    if (!receipt) continue;
    const entry = workShowcaseEntry(disclosure, receipt);
    if (entry) entries.push(entry);
  }
  return entries.sort((left, right) => (left.teamId < right.teamId ? -1 : left.teamId > right.teamId ? 1 : 0));
}

/** 队伍侧视图：只含本队记录（即使调用方误传入其他队伍数据也会在这里被过滤掉）。 */
export function myWorkDisclosureView(input: {
  readonly teamId: EntityId; readonly hasFormalReceipt: boolean; readonly records: readonly WorkDisclosure[];
}): MyWorkDisclosure {
  const own = input.records
    .filter(record => record.teamId === input.teamId)
    .sort((left, right) => (left.updatedAt > right.updatedAt ? -1 : left.updatedAt < right.updatedAt ? 1 : left.id > right.id ? -1 : left.id < right.id ? 1 : 0));
  const active = own.find(record => record.status === "active") ?? null;
  return {
    teamId: input.teamId,
    hasFormalReceipt: input.hasFormalReceipt,
    canSubmit: input.hasFormalReceipt,
    reason: input.hasFormalReceipt
      ? (active ? "你们队已经提交过公开范围；再次提交会取代上一次选择（旧选择保留为不可改写的历史）。" : null)
      : "本场还没有这支队伍的正式收件记录；正式交件后才能选择公开范围。",
    active: active ? { id: active.id, scope: active.scope, fields: active.fields, authorUserId: active.authorUserId, revision: active.revision, updatedAt: active.updatedAt } : null,
    history: own.map(record => ({ id: record.id, scope: record.scope, fields: record.fields, status: record.status,
      authorUserId: record.authorUserId, revision: record.revision, updatedAt: record.updatedAt, withdrawnAt: record.withdrawnAt })),
    notices: { ...workDisclosureNotices },
  };
}

export const workShowcaseLimitations: readonly string[] = [
  "只列队伍本人主动选择公开的队伍的字段，且只含该队逐项勾选的内容；未勾选的字段不出现。",
  "联系人、邮箱、答卷、求助、住宿、队伍专属反馈与评委身份永不进入本投影。",
  "作品展示不改变分数、名次、公布与既有导出；点评（文字留言与数值互评）是后续独立能力。",
  "队伍撤回后立即从展示中消失；撤回之后可以重新提交。",
  "仅本场参赛者可见的作品只对本场报名已通过的选手返回；主办方开关关闭时一律 403，不返回空列表。",
];
export const workShowcaseNotice = "本页是作品展示：只显示队伍主动选择公开的内容。分数、名次与公布请看结果页。";
export const organizerWorkShowcaseNotice = "只显示队伍本人选择公开的作品；未选择或选择不公开的队伍只计入数量，不显示身份。";
