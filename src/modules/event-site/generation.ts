import { DomainError } from "../../shared/errors.ts";
import { defaultPageSpec } from "./blocks.ts";
import type { EventSiteBlockNode, EventSitePageSpec } from "./model.ts";
import { reviewSpec } from "./policy.ts";
import type { EventSitePolicyFinding } from "./policy.ts";
import {
  EVENT_SITE_EVENT_KINDS, EVENT_SITE_GENERATION_SYSTEM_PROMPT, EVENT_SITE_SUGGESTION_SYSTEM_PROMPT,
  buildGenerationUserPrompt, buildSuggestionUserPrompt,
} from "./prompt.ts";
import type { EventSiteEventKind, EventSiteGenerationIntent } from "./prompt.ts";
import { normalizeSpec, parseSpec } from "./validation.ts";

/**
 * 专属页的**生成与建议**（规划 35 P2：§6.1 一键生成、§20.2 建议、§20.4 边界）。
 *
 * 这一层只有两个动作，都不落库、不写审计、不注册路由、不碰 UI：
 * - `generatePage(intent)`：结构化意图 → 整页规格草案（含每块 priority 与 collapse）；
 * - `suggestForSpec(spec)`：当前规格 → 最多 3 条建议（**只建议，永不自动改**）。
 *
 * 四条结构性纪律：
 * 1. **模型只是 Port**：本模块不接网络。端口未注入或 `available !== true` 一律
 *    `EVENT_SITE_MODEL_UNAVAILABLE`（503），并在消息里说明人工流程照常。
 * 2. **输出过 P1a 闸门**：AI 只能产出 `EventSitePageSpec`，且必须过 `parseSpec`（严格形态）。
 *    未知 kind、未知字段、超限值、事实类手写值全部拒绝，**不做"尽力修正"**——
 *    失败就失败，不静默重试、不修一半再用。
 * 3. **失败行为分两种，由参数选**：`generatePage({ fallback })` 默认 `"default"`
 *    （按规划 §6.1「失败时退回默认模板」，返回 `defaultPageSpec()` 并标注 `usedFallback`）；
 *    传 `"error"` 时抛 `EVENT_SITE_MODEL_RESULT_INVALID`（503）。两种都不重试。
 * 4. **只出草案**：`suggestForSpec` 的 patch 也只通过校验才返回（非法整条丢弃并计入 `dropped`），
 *    从不写任何东西；采纳与否由主办方决定。
 *
 * 用量：端口返回里若带 `usage` 就原样核对后返回，没有就是 `null`（不编造）。
 * 审计与账本由根负责——这里没有数据库依赖，也没有任何写路径。
 */

/* ------------------------------------------------------------------ *
 * 上限与常量
 * ------------------------------------------------------------------ */

/** 一次整页生成的最大输出 token（根接账本时按它做单次上限，规划 35 §13）。 */
export const EVENT_SITE_GENERATION_MAX_OUTPUT_TOKENS = 3600;
/** 一次建议的最大输出 token。 */
export const EVENT_SITE_SUGGESTION_MAX_OUTPUT_TOKENS = 1200;
/** 一次最多返回的建议条数（规划 35 §20.3「一次给 3 条建议」）。 */
export const EVENT_SITE_MAX_SUGGESTIONS = 3;

export const EVENT_SITE_SUGGESTION_ID_MAX = 64;
export const EVENT_SITE_SUGGESTION_TITLE_MAX = 80;
export const EVENT_SITE_SUGGESTION_RATIONALE_MAX = 400;

export const EVENT_SITE_INTENT_TITLE_MAX = 120;
export const EVENT_SITE_INTENT_AUDIENCE_MAX = 200;
export const EVENT_SITE_INTENT_TONE_MAX = 60;
export const EVENT_SITE_INTENT_NOTES_MAX = 1000;
export const EVENT_SITE_INTENT_EMPHASIS_MAX = 8;
export const EVENT_SITE_INTENT_EMPHASIS_ITEM_MAX = 40;

/** 不可见控制字符（保留 tab / 换行 / 回车）。 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const INTENT_FIELDS = new Set(["eventTitle", "kind", "audience", "emphasis", "tone", "notes"]);
const SUGGESTION_FIELDS = new Set(["id", "title", "rationale", "patch"]);
const PATCH_FIELDS = new Set(["kind", "blockId", "block"]);
const PATCH_KINDS: readonly EventSiteSuggestionPatchKind[] = ["replace_block", "add_block", "remove_block"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * 模型 Port（只定义，实现由根适配既有 AI 账本）
 * ------------------------------------------------------------------ */

/** 一次模型调用的用量。端口不给就是 `null`，本模块不推算。 */
export interface EventSiteModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * 模型端口：根用**既有 AI 账本**适配（预留 → 调用 → 按 usage 结算），本模块不接网络。
 *
 * `systemPrompt` 永远是 prompt.ts 里的固定常量，`input` 只放用户数据——
 * 这样"用户在赛事名里写指令"改不动规则。
 */
export interface EventSiteModelPort {
  readonly available: boolean;
  readonly modelVersion: string;
  complete(request: {
    readonly systemPrompt: string;
    readonly input: string;
    readonly maxOutputTokens: number;
  }): Promise<{ readonly content: unknown }>;
}

function modelUnavailable(): DomainError {
  return new DomainError(
    "EVENT_SITE_MODEL_UNAVAILABLE",
    "页面生成模型尚未接入或当前不可用，这次没有生成任何内容；主办方仍可手动编辑专属页、套用默认模块集或模板，人工流程照常。",
    { status: 503, recoveryAction: "use_default_page_spec" },
  );
}

/** 端口就位且版本号可核对才算可用；版本号缺失视为不可用（账本要记它）。 */
function modelOrThrow(model: EventSiteModelPort | null | undefined): EventSiteModelPort {
  if (model === null || model === undefined || model.available !== true) throw modelUnavailable();
  if (typeof model.modelVersion !== "string" || model.modelVersion.trim().length === 0) throw modelUnavailable();
  return model;
}

interface ModelAnswer {
  readonly content: unknown;
  readonly usage: EventSiteModelUsage | null;
}

/** 只取**可核对**的用量：字段缺失或非法都返回 null（不猜、不补零）。 */
function usageFrom(value: unknown): EventSiteModelUsage | null {
  if (!isRecord(value)) return null;
  const usage = value.usage;
  if (!isRecord(usage)) return null;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0) return null;
  if (typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0) return null;
  return { inputTokens: inputTokens, outputTokens: outputTokens };
}

async function callModel(
  model: EventSiteModelPort, systemPrompt: string, input: string, maxOutputTokens: number,
): Promise<ModelAnswer> {
  let response: unknown;
  try {
    response = await model.complete({ systemPrompt: systemPrompt, input: input, maxOutputTokens: maxOutputTokens });
  } catch {
    // 提供方原文不外泄（可能含地址、密钥或内部标识）；这里只给可操作的结论。
    throw new DomainError(
      "EVENT_SITE_MODEL_UNAVAILABLE",
      "页面生成模型这次调用失败，没有生成任何内容；主办方仍可手动编辑专属页或套用默认模块集与模板，人工流程照常。",
      { status: 503, recoveryAction: "use_default_page_spec" },
    );
  }
  if (!isRecord(response)) return { content: undefined, usage: null };
  return { content: response.content, usage: usageFrom(response) };
}

/* ------------------------------------------------------------------ *
 * 结构化意图的严格校验
 * ------------------------------------------------------------------ */

function invalidIntent(message: string): never {
  throw new DomainError("EVENT_SITE_GENERATION_INTENT_INVALID", message, { status: 422 });
}

function intentTooLong(message: string): never {
  throw new DomainError("EVENT_SITE_GENERATION_INTENT_TOO_LONG", message, { status: 422 });
}

function intentText(value: unknown, label: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) invalidIntent(label + "不能为空。");
    return null;
  }
  if (typeof value !== "string") invalidIntent(label + "必须是纯文本。");
  if (CONTROL_CHARACTERS.test(value)) invalidIntent(label + "包含不可见控制字符。");
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) invalidIntent(label + "不能为空。");
    return null;
  }
  if (Array.from(trimmed).length > max) {
    intentTooLong(label + "最多 " + String(max) + " 个字符，当前 " + String(Array.from(trimmed).length) + " 个。");
  }
  return trimmed;
}

function emphasisField(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalidIntent("想强调（emphasis）必须是字符串数组。");
  if (value.length > EVENT_SITE_INTENT_EMPHASIS_MAX) {
    intentTooLong("想强调最多 " + String(EVENT_SITE_INTENT_EMPHASIS_MAX) + " 条，当前 " + String(value.length) + " 条。");
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") invalidIntent("想强调的每一条都必须是纯文本。");
    if (CONTROL_CHARACTERS.test(entry)) invalidIntent("想强调里包含不可见控制字符。");
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (Array.from(trimmed).length > EVENT_SITE_INTENT_EMPHASIS_ITEM_MAX) {
      intentTooLong("想强调的每一条最多 " + String(EVENT_SITE_INTENT_EMPHASIS_ITEM_MAX) + " 个字符。");
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * 校验结构化意图：未知字段、非法 kind、超长文案、控制字符一律拒绝。
 * 重复的 emphasis 会按首次出现去重（不改变顺序，也不编造新项）。
 */
export function parseGenerationIntent(input: unknown): EventSiteGenerationIntent {
  if (!isRecord(input)) invalidIntent("生成意图必须是一个对象。");
  for (const key of Object.keys(input)) {
    if (!INTENT_FIELDS.has(key)) invalidIntent("生成意图不接受字段「" + key + "」。");
  }
  const eventTitle = intentText(input.eventTitle, "比赛名称", EVENT_SITE_INTENT_TITLE_MAX, true) as string;
  const kindRaw = input.kind;
  if (typeof kindRaw !== "string" || !(EVENT_SITE_EVENT_KINDS as readonly string[]).includes(kindRaw)) {
    throw new DomainError(
      "EVENT_SITE_GENERATION_INTENT_KIND_UNKNOWN",
      "比赛类型只能是 " + EVENT_SITE_EVENT_KINDS.join(" / ") + "，收到「" + String(kindRaw) + "」。",
      { status: 422 },
    );
  }
  const audience = intentText(input.audience, "目标人群", EVENT_SITE_INTENT_AUDIENCE_MAX, true) as string;
  const tone = intentText(input.tone, "语气", EVENT_SITE_INTENT_TONE_MAX, true) as string;
  const notes = intentText(input.notes, "补充说明", EVENT_SITE_INTENT_NOTES_MAX, false);
  return {
    eventTitle: eventTitle,
    kind: kindRaw as EventSiteEventKind,
    audience: audience,
    emphasis: emphasisField(input.emphasis),
    tone: tone,
    notes: notes,
  };
}

/* ------------------------------------------------------------------ *
 * 一、一键生成：意图 → 整页草案
 * ------------------------------------------------------------------ */

/** 模型输出不合法时的行为：`default` = 退回默认模板（P2 默认）；`error` = 503。 */
export type EventSiteGenerationFallback = "default" | "error";

export interface EventSiteGenerationFailure {
  /** 底层封闭校验的错误码（例如 EVENT_SITE_UNKNOWN_BLOCK_KIND），便于根与界面定位。 */
  readonly code: string;
  readonly message: string;
}

export interface EventSiteGenerationResult {
  readonly spec: EventSitePageSpec;
  readonly findings: readonly EventSitePolicyFinding[];
  readonly modelVersion: string;
  /** 端口没提供可核对的用量时为 null。 */
  readonly usage: EventSiteModelUsage | null;
  /** true 表示这次返回的是 `defaultPageSpec()`（模型输出没通过校验），不是模型产物。 */
  readonly usedFallback: boolean;
  /** 失败原因；成功为 null。 */
  readonly failure: EventSiteGenerationFailure | null;
}

export interface EventSiteGenerateOptions {
  /** 根注入的模型端口；不注入一律 503，人工流程照常。 */
  readonly model?: EventSiteModelPort | null;
  readonly intent: unknown;
  readonly fallback?: EventSiteGenerationFallback;
}

type SpecOutcome =
  | { readonly kind: "ok"; readonly spec: EventSitePageSpec }
  | { readonly kind: "invalid"; readonly code: string; readonly message: string };

/**
 * 把模型输出交给 P1a 的**严格**闸门：`parseSpec`。
 *
 * 严格形态要求每块都带 id / kind / variant / priority / collapse，所以
 * "模型省掉 priority 与 collapse，让引擎猜手机语义"在结构上做不到。
 */
function readGeneratedSpec(content: unknown): SpecOutcome {
  try {
    return { kind: "ok", spec: parseSpec(content) };
  } catch (error) {
    if (error instanceof DomainError) return { kind: "invalid", code: error.code, message: error.message };
    return { kind: "invalid", code: "EVENT_SITE_MODEL_RESULT_INVALID", message: "模型输出无法解析为页面规格。" };
  }
}

function invalidModelResult(code: string, message: string): DomainError {
  return new DomainError(
    "EVENT_SITE_MODEL_RESULT_INVALID",
    "模型输出不合法（" + code + "）：" + message + "；没有做任何自动修正，也没有重试。可以改用默认模块集或手动编辑。",
    { status: 503, recoveryAction: "use_default_page_spec" },
  );
}

/**
 * 一键生成：结构化意图 → **整页规格草案**（不落库、不发布）。
 *
 * 失败行为（写死在这里，不静默）：
 * - 端口未注入 / `available !== true` / 没有版本号 → `EVENT_SITE_MODEL_UNAVAILABLE`（503）；
 * - 模型调用抛错 → `EVENT_SITE_MODEL_UNAVAILABLE`（503），不重试；
 * - 模型输出过不了 `parseSpec`：
 *   - `fallback: "default"`（默认）→ 返回 `defaultPageSpec()`，`usedFallback: true`，
 *     `failure` 里带底层错误码；**这就是规划 §6.1「失败时退回默认模板」**；
 *   - `fallback: "error"` → 抛 `EVENT_SITE_MODEL_RESULT_INVALID`（503）。
 * 两种情况都只调用模型一次。
 */
export async function generatePage(options: EventSiteGenerateOptions): Promise<EventSiteGenerationResult> {
  const fallback = options.fallback ?? "default";
  if (fallback !== "default" && fallback !== "error") {
    throw new DomainError("EVENT_SITE_GENERATION_OPTIONS_INVALID", "fallback 只能是 default 或 error。", { status: 422 });
  }
  const intent = parseGenerationIntent(options.intent);
  const model = modelOrThrow(options.model);
  const answer = await callModel(
    model,
    EVENT_SITE_GENERATION_SYSTEM_PROMPT,
    buildGenerationUserPrompt(intent),
    EVENT_SITE_GENERATION_MAX_OUTPUT_TOKENS,
  );
  const outcome = readGeneratedSpec(answer.content);
  if (outcome.kind === "ok") {
    return {
      spec: outcome.spec,
      findings: reviewSpec(outcome.spec),
      modelVersion: model.modelVersion,
      usage: answer.usage,
      usedFallback: false,
      failure: null,
    };
  }
  if (fallback === "error") throw invalidModelResult(outcome.code, outcome.message);
  const spec = defaultPageSpec();
  return {
    spec: spec,
    findings: reviewSpec(spec),
    modelVersion: model.modelVersion,
    usage: answer.usage,
    usedFallback: true,
    failure: { code: outcome.code, message: outcome.message },
  };
}

/* ------------------------------------------------------------------ *
 * 二、生成助手建议：当前规格 → 最多 3 条建议（只建议，永不自动改）
 * ------------------------------------------------------------------ */

export type EventSiteSuggestionPatchKind = "replace_block" | "add_block" | "remove_block";

/**
 * 一条建议的改法。`block` 一定是**通过封闭校验后**的完整区块（canonical），
 * 不是模型原文——这样根可以直接采用，也可以先给人看。
 */
export interface EventSiteSuggestionPatch {
  readonly kind: EventSiteSuggestionPatchKind;
  readonly blockId?: string;
  readonly block?: EventSiteBlockNode;
}

export interface EventSiteSuggestion {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  /** 可选：没有 patch 就是一条纯文字建议。 */
  readonly patch?: EventSiteSuggestionPatch;
}

export interface EventSiteSuggestionResult {
  readonly suggestions: readonly EventSiteSuggestion[];
  /** 被丢弃的条数（非法 patch、非法字段、重复 id、超出 3 条都算，绝不静默截断）。 */
  readonly dropped: number;
  readonly findings: readonly EventSitePolicyFinding[];
  readonly modelVersion: string;
  readonly usage: EventSiteModelUsage | null;
}

export interface EventSiteSuggestOptions {
  readonly model?: EventSiteModelPort | null;
  readonly spec: unknown;
}

function envelopeFailure(reason: string): DomainError {
  return new DomainError(
    "EVENT_SITE_MODEL_RESULT_INVALID",
    "模型没有给出可读的建议清单（" + reason + "）；页面没有被修改，也没有做任何自动修正。可以稍后再试或手动编辑。",
    { status: 503, recoveryAction: "retry_or_edit_manually" },
  );
}

function readSuggestionEnvelope(content: unknown): readonly unknown[] {
  if (!isRecord(content)) throw envelopeFailure("返回的不是一个对象");
  for (const key of Object.keys(content)) {
    if (key !== "suggestions") throw envelopeFailure("出现不认识的字段「" + key + "」");
  }
  const raw = content.suggestions;
  if (!Array.isArray(raw)) throw envelopeFailure("缺少 suggestions 数组");
  return raw;
}

function suggestionText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (CONTROL_CHARACTERS.test(value)) return null;
  if (/[<>]/.test(value)) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (Array.from(trimmed).length > max) return null;
  return trimmed;
}

/**
 * 把 `null` 当成缺省（P1a 在**区块字段**上本来就这么判：`rejectUnknownFields` 跳过 null）。
 *
 * 为什么需要它：P1a 规范化后的 items 一定带 `image: null`，而 `itemsField` 不跳过 null，
 * 于是"再校验一遍规范化结果"会报 `EVENT_SITE_UNKNOWN_BLOCK_FIELD`（见交付文档 §13 的 P1a 边界记录）。
 * 本模块只对**已经合法过一次**的规格做重校验，所以这里按缺省处理，不改变任何校验规则；
 * 模型新给的块同样走这条路，不会因此绕过 kind / 字段 / 上限 / 事实手写任何一条。
 */
function withoutNulls(value: unknown, seen?: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map(entry => withoutNulls(entry, seen));
  if (!isRecord(value)) return value;
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value)) return value;
  visited.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    out[key] = withoutNulls(entry, visited);
  }
  return out;
}

/** 候选整页：任何一条不合法就返回 null（整条建议丢弃，不修一修再用）。 */
function tryParseSpec(blocks: readonly unknown[]): EventSitePageSpec | null {
  try {
    return parseSpec(withoutNulls({ version: 1, blocks: blocks }));
  } catch {
    return null;
  }
}

type PatchOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly patch: EventSiteSuggestionPatch }
  | { readonly kind: "invalid" };

const INVALID_PATCH: PatchOutcome = { kind: "invalid" };

/**
 * patch 的封闭校验：形状 → 目标存在 → 整页重跑 parseSpec。
 *
 * 关键点：校验的是**改完之后的整页**，不是单块。所以"删掉被 AI 组件管辖的块"
 * （整页会变成 EVENT_SITE_AI_SCOPE_UNKNOWN_BLOCK）和"新增第 4 个 AI 组件"都会被挡。
 */
function readSuggestionPatch(raw: unknown, current: EventSitePageSpec): PatchOutcome {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (!isRecord(raw)) return INVALID_PATCH;
  for (const key of Object.keys(raw)) {
    if (!PATCH_FIELDS.has(key)) return INVALID_PATCH;
  }
  const kindRaw = raw.kind;
  if (typeof kindRaw !== "string" || !PATCH_KINDS.includes(kindRaw as EventSiteSuggestionPatchKind)) return INVALID_PATCH;
  const kind = kindRaw as EventSiteSuggestionPatchKind;
  const blockIdRaw = raw.blockId;
  const blockRaw = raw.block;
  const existing = new Set(current.blocks.map(block => block.id));

  if (kind === "remove_block") {
    if (blockRaw !== undefined && blockRaw !== null) return INVALID_PATCH;
    if (typeof blockIdRaw !== "string") return INVALID_PATCH;
    const blockId = blockIdRaw.trim();
    if (!existing.has(blockId)) return INVALID_PATCH;
    if (tryParseSpec(current.blocks.filter(block => block.id !== blockId)) === null) return INVALID_PATCH;
    return { kind: "ok", patch: { kind: "remove_block", blockId: blockId } };
  }

  if (!isRecord(blockRaw)) return INVALID_PATCH;
  if (kind === "add_block") {
    if (blockIdRaw !== undefined && blockIdRaw !== null) return INVALID_PATCH;
    const addedId = blockRaw.id;
    if (typeof addedId !== "string") return INVALID_PATCH;
    const parsed = tryParseSpec([...current.blocks, blockRaw]);
    if (parsed === null) return INVALID_PATCH;
    const node = parsed.blocks.find(block => block.id === addedId.trim());
    if (node === undefined) return INVALID_PATCH;
    return { kind: "ok", patch: { kind: "add_block", block: node } };
  }

  if (typeof blockIdRaw !== "string") return INVALID_PATCH;
  const blockId = blockIdRaw.trim();
  if (!existing.has(blockId)) return INVALID_PATCH;
  if (blockRaw.id !== blockId) return INVALID_PATCH;
  const parsed = tryParseSpec(current.blocks.map(block => (block.id === blockId ? blockRaw : block)));
  if (parsed === null) return INVALID_PATCH;
  const node = parsed.blocks.find(block => block.id === blockId);
  if (node === undefined) return INVALID_PATCH;
  return { kind: "ok", patch: { kind: "replace_block", blockId: blockId, block: node } };
}

function readSuggestion(
  raw: unknown, current: EventSitePageSpec, seen: ReadonlySet<string>,
): EventSiteSuggestion | null {
  if (!isRecord(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (!SUGGESTION_FIELDS.has(key)) return null;
  }
  const id = suggestionText(raw.id, EVENT_SITE_SUGGESTION_ID_MAX);
  if (id === null || seen.has(id)) return null;
  const title = suggestionText(raw.title, EVENT_SITE_SUGGESTION_TITLE_MAX);
  if (title === null) return null;
  const rationale = suggestionText(raw.rationale, EVENT_SITE_SUGGESTION_RATIONALE_MAX);
  if (rationale === null) return null;
  const patch = readSuggestionPatch(raw.patch, current);
  if (patch.kind === "invalid") return null;
  return patch.kind === "none"
    ? { id: id, title: title, rationale: rationale }
    : { id: id, title: title, rationale: rationale, patch: patch.patch };
}

/**
 * 生成助手建议：读当前规格，给**最多 3 条**建议，**只建议、不自动改**。
 *
 * 失败与丢弃分开：
 * - 端口不可用 / 调用失败 → `EVENT_SITE_MODEL_UNAVAILABLE`（503）；
 * - 输出不是 `{"suggestions":[...]}` 信封 → `EVENT_SITE_MODEL_RESULT_INVALID`（503）；
 * - 单条建议非法（未知字段、未知 patch.kind、目标不存在、patch 后整页不合法、重复 id）
 *   → **丢弃那一条**并计入 `dropped`，其余照常返回；不做自动修正。
 * - 合法建议超过 3 条 → 只回前 3 条，其余计入 `dropped`（不静默截断）。
 *
 * 当前规格本身也要先过 `normalizeSpec`：不合法的规格无法给建议，直接抛 P1a 的 422。
 */
export async function suggestForSpec(options: EventSiteSuggestOptions): Promise<EventSiteSuggestionResult> {
  const current = normalizeSpec(withoutNulls(options.spec));
  const model = modelOrThrow(options.model);
  const answer = await callModel(
    model,
    EVENT_SITE_SUGGESTION_SYSTEM_PROMPT,
    buildSuggestionUserPrompt(withoutNulls(current) as EventSitePageSpec),
    EVENT_SITE_SUGGESTION_MAX_OUTPUT_TOKENS,
  );
  const raw = readSuggestionEnvelope(answer.content);
  const suggestions: EventSiteSuggestion[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of raw) {
    if (suggestions.length >= EVENT_SITE_MAX_SUGGESTIONS) {
      dropped += 1;
      continue;
    }
    const suggestion = readSuggestion(entry, current, seen);
    if (suggestion === null) {
      dropped += 1;
      continue;
    }
    seen.add(suggestion.id);
    suggestions.push(suggestion);
  }
  return {
    suggestions: suggestions,
    dropped: dropped,
    findings: reviewSpec(current),
    modelVersion: model.modelVersion,
    usage: answer.usage,
  };
}
