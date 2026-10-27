/**
 * 检查条件细化（规划27 第 3.5 项）· 纯校验与合并。
 *
 * 本文件只做一件事：把团队任务原有的 `acceptanceCriteria` 与负责人提交的细化条目
 * 合并成一份**只增不减**的新条件数组，并保留“谁在何时改了什么”的痕迹。
 *
 * 硬约束（与分工文件第 2 节 S4 一致）：
 * 1. 不删除、不改写任何已有条件：已有条目按原顺序原文保留；要停用只能**标注作废**，
 *    作废必须带走原文与理由（`voided[].text` / `voided[].reason`）。
 * 2. 可追溯：每条被接受的新增与每条作废都带 `byUserId` / `at`，另有 `trace` 汇总。
 * 3. 空输入返回原样：`{ criteria: [...existing] }`，新增/作废/拒绝都是空数组。
 * 4. 输入校验不抛异常：空字符串、纯空白、控制字符、超长、缺作者或时间、时间格式不合法、
 *    非法操作、非法字段、重复条目，全部写入 `rejected` 并给理由与 `reasonCode`。
 * 5. 无副作用：不读库、不写库、不改状态、不调用 `Date.now()`，也不修改传入的数组或对象。
 *
 * 未做的事：不判断当前用户对这只团队任务是否真有权限改检查条件——那属于根服务的真实
 * 权限事实。调用方必须先查完权限，再把结论作为 `actorMayRefine` 传进来（见交付说明）。
 */

export const ACCEPTANCE_DETAIL_MAX_TEXT_LENGTH = 500;
export const ACCEPTANCE_DETAIL_MAX_CRITERIA = 200;
export const ACCEPTANCE_DETAIL_MAX_PROPOSALS = 200;
export const ACCEPTANCE_DETAIL_MIN_VOID_REASON_LENGTH = 8;

/** 为什么没被接受。界面可据此给中文提示，测试可精确断言。 */
export type AcceptanceDetailReasonCode =
  | "TEXT_MISSING"
  | "TEXT_TOO_LONG"
  | "TEXT_CONTROL_CHARACTER"
  | "AUTHOR_MISSING"
  | "TIME_MISSING"
  | "TIME_INVALID"
  | "NOT_OBJECT"
  | "INVALID_OPERATION"
  | "VOID_REASON_MISSING"
  | "VOID_TARGET_NOT_FOUND"
  | "VOID_TARGET_ALREADY_VOIDED"
  | "DUPLICATE_CRITERION"
  | "CRITERIA_LIMIT_REACHED"
  | "PERMISSION_NOT_CONFIRMED"
  | "INPUT_NOT_ARRAY"
  | "PROPOSALS_LIMIT_REACHED";

/** 负责人提交的一条细化：一次要么“追加一条更具体的条件”，要么“标注某条作废”。 */
export interface AcceptanceDetailProposal {
  /** 新增时的条件正文；作废时表示要作废的那条已有条件原文。 */
  readonly text: string;
  readonly byUserId: string;
  /** 带时区的 ISO-8601 时刻字符串，例如 `2026-10-12T03:00:00.000Z`。 */
  readonly at: string;
  /** 为 true 时本次是“标注作废”，不新增内容。 */
  readonly void?: boolean;
  /** 作废理由，必填；作废后原文与理由一并保留，便于追溯。 */
  readonly voidReason?: string;
}

export interface AcceptanceDetailInput {
  readonly existing: readonly string[];
  readonly proposed: readonly AcceptanceDetailProposal[];
  readonly actorUserId: string;
  /**
   * 根服务对“当前用户是否可以细化这只任务的检查条件”的真实权限结论。
   * 只接受显式 `true`：没查过权限时（`undefined`）宁可拒绝一条，也不静默接受一条，
   * 否则审计会记下没被校验过的作者身份。
   */
  readonly actorMayRefine?: boolean;
}

/** 一条被接受的细化，保留原提交的作者与时刻。 */
export interface AcceptanceDetailAccepted {
  readonly text: string;
  readonly byUserId: string;
  readonly at: string;
}

/** 一条作废标注：原文与理由都在，已有条件本身没有被删除。 */
export interface AcceptanceDetailVoided extends AcceptanceDetailAccepted {
  readonly reason: string;
}

export interface AcceptanceDetailRejection {
  /** 能读出原文时保留原文，便于负责人照着改；读不出时为空字符串。 */
  readonly text: string;
  readonly reason: string;
  readonly reasonCode: AcceptanceDetailReasonCode;
}

/**
 * 追加式审计轨迹。`added` 与 `voided` 顺序即实际处理顺序；
 * `rejected` 也逐条留痕，保证“提交过什么、为什么没生效”可复查。
 */
export type AcceptanceDetailTraceEntry =
  | { readonly action: "added"; readonly text: string; readonly byUserId: string; readonly at: string; readonly applied: true }
  | { readonly action: "voided"; readonly text: string; readonly byUserId: string; readonly at: string; readonly applied: true; readonly reason: string }
  | { readonly action: "rejected"; readonly text: string; readonly byUserId: string; readonly at: string; readonly applied: false; readonly reasonCode: AcceptanceDetailReasonCode; readonly reason: string };

export interface AcceptanceDetailResult {
  /** 合并后的完整条件数组：已有条目按原顺序原文保留，通过校验的新增追加在末尾。 */
  readonly criteria: string[];
  readonly added: AcceptanceDetailAccepted[];
  readonly voided: AcceptanceDetailVoided[];
  readonly rejected: AcceptanceDetailRejection[];
  readonly trace: AcceptanceDetailTraceEntry[];
  /** 中文变更摘要，可直接展示。 */
  readonly summary: string;
}

const MESSAGE: Record<AcceptanceDetailReasonCode, string> = {
  TEXT_MISSING: "条件内容不能为空，也不能只有空格、换行或不可见字符。",
  TEXT_TOO_LONG: `单条检查条件最多 ${ACCEPTANCE_DETAIL_MAX_TEXT_LENGTH} 个字，请拆成几条更具体的条件。`,
  TEXT_CONTROL_CHARACTER: "条件内容里不能有控制字符或零宽字符，请只写一段可读文字。",
  AUTHOR_MISSING: "缺少提交人，无法记录是谁改的。",
  TIME_MISSING: "缺少提交时刻，无法记录是什么时候改的。",
  TIME_INVALID: "提交时刻必须是带时区的 ISO-8601 时间，例如 2026-10-12T03:00:00.000Z。",
  NOT_OBJECT: "这条细化不是一条有效记录，请按“文字 + 提交人 + 时刻”重新提交。",
  INVALID_OPERATION: "void 只能是 true 或 false；要追加条件请不要传 void。",
  VOID_REASON_MISSING: `作废已有条件必须写理由（至少 ${ACCEPTANCE_DETAIL_MIN_VOID_REASON_LENGTH} 个字），否则无法追溯为什么不再用这条条件。`,
  VOID_TARGET_NOT_FOUND: "要作废的条件不在当前检查条件里，请先核对原文，作废不会凭空新增条目。",
  VOID_TARGET_ALREADY_VOIDED: "这条条件已经标注过作废，已有条件不会被删除，也不需要再作废一次。",
  DUPLICATE_CRITERION: "这条内容已经存在于检查条件中，重复条目不会被追加。",
  CRITERIA_LIMIT_REACHED: `检查条件最多 ${ACCEPTANCE_DETAIL_MAX_CRITERIA} 条，请先合并或作废过细的旧条件。`,
  PERMISSION_NOT_CONFIRMED: "这次改动的提交人不是当前操作人，或尚未核对细化权限，不能记入检查条件。",
  INPUT_NOT_ARRAY: "细化提交不是一个列表，本次没有任何改动。",
  PROPOSALS_LIMIT_REACHED: `一次最多提交 ${ACCEPTANCE_DETAIL_MAX_PROPOSALS} 条细化，本次整批未处理，请分几次提交。`,
};

/**
 * 可折叠的空白：制表、换行、不换行空格、行/段分隔符（U+2028/2029）。
 * 它们折叠成普通空格后内容仍完整可读（`两行\u2028分开` → `两行 分开`），
 * 所以按“保留内容”处理，而不是整条拒绝。
 */
const COLLAPSIBLE_WHITESPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);

/**
 * 不可见又不属于空白的内容一律拒绝：C0/C1 控制字符、零宽字符（U+200B–U+200F、U+2060）、
 * 方向隔离符与私用不可见字符。宁可拒绝并说明，也不把看不见的字符悄悄接受下来。
 */
function isRejectedControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069)
    || code === 0xfff9 || code === 0xfffa || code === 0xfffb;
}

type TextInspection =
  | { readonly state: "valid"; readonly text: string }
  | { readonly state: "missing" }
  | { readonly state: "control" };

/**
 * 读出可用的条件文字：折叠空白，并按码点判定不可见字符。
 * `missing` = 空、纯空白或不是字符串；`control` = 含控制字符或零宽字符。
 */
function inspectText(value: unknown): TextInspection {
  if (typeof value !== "string") return { state: "missing" };
  let normalized = "";
  let previousWasSpace = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // 先折叠可读空白，再判不可见字符：制表符、换行本身就是空白，不该被当成控制字符拒绝。
    if (COLLAPSIBLE_WHITESPACE.has(code)) {
      if (!previousWasSpace && normalized) normalized += " ";
      previousWasSpace = true;
      continue;
    }
    if (isRejectedControl(code)) return { state: "control" };
    normalized += character;
    previousWasSpace = false;
  }
  const collapsed = normalized.trim();
  return collapsed ? { state: "valid", text: collapsed } : { state: "missing" };
}

/** 只要文字；格式问题由调用方用 inspectText 区分理由。 */
function readText(value: unknown): string | undefined {
  const inspected = inspectText(value);
  return inspected.state === "valid" ? inspected.text : undefined;
}

function readIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:\d{2})$/;

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/**
 * 比较用的规范化键：与 inspectText 同一套折叠规则；已有条目就算格式不合法也要能被找到并判重
 * （它会被原样保留，所以必须对得上），因此读不出时退回原文 trim。
 */
function comparisonKey(value: string): string {
  return readText(value) ?? value.trim();
}

function isIsoTimestamp(value: string): boolean {
  if (!TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function proposalLabel(value: unknown): string {
  return isPlainObject(value) && typeof value.text === "string" ? value.text : "";
}

function proposeHumanReadableList(values: readonly string[], limit: number): string {
  const head = values.slice(0, limit).map(value => `“${value}”`).join("、");
  return values.length > limit ? `${head} 等 ${values.length} 条` : head;
}

/** 检查条件细化：校验、合并、留痕。纯函数，不产生任何副作用。 */
export function detailAcceptance(input: AcceptanceDetailInput): AcceptanceDetailResult {
  const existing = Array.isArray(input?.existing) ? input.existing : [];
  const existingTexts: string[] = existing.filter((value): value is string => typeof value === "string");
  const criteria: string[] = [...existingTexts];
  const added: AcceptanceDetailAccepted[] = [];
  const voided: AcceptanceDetailVoided[] = [];
  const rejected: AcceptanceDetailRejection[] = [];
  const trace: AcceptanceDetailTraceEntry[] = [];

  const acceptedKeys = new Set<string>();
  for (const text of existingTexts) {
    const key = comparisonKey(text);
    if (key) acceptedKeys.add(key);
  }
  const voidedKeys = new Set<string>();
  const accepted: AcceptanceDetailAccepted[] = [];

  const actorUserId = readIdentity(input?.actorUserId);
  const actorMayRefine = input?.actorMayRefine === true;

  /**
   * 登记一条拒绝：`rejected` 与 `trace` 同时留痕。
   * 只由紧跟其后的 `continue` / `return` 调用，绝不改变 criteria、added 或 voided。
   */
  const reject = (reasonCode: AcceptanceDetailReasonCode, parts: { text: string; byUserId: string; at: string }): void => {
    const reason = MESSAGE[reasonCode];
    rejected.push({ text: parts.text, reason, reasonCode });
    trace.push({ action: "rejected", text: parts.text, byUserId: parts.byUserId, at: parts.at, applied: false, reasonCode, reason });
  };

  const proposedInput: unknown = input?.proposed;

  // 细化提交整体不是数组：按“一条都没改”处理，而不是抛异常或猜。
  if (!Array.isArray(proposedInput)) {
    reject("INPUT_NOT_ARRAY", { text: "", byUserId: "", at: "" });
    return finish(criteria, added, voided, rejected, trace);
  }

  const submitted: readonly unknown[] = proposedInput;

  // 一次提交过多：宁可整批拒绝并说明，也不静默丢掉后面的条目（审计要求“提交过什么”可查）。
  if (submitted.length > ACCEPTANCE_DETAIL_MAX_PROPOSALS) {
    reject("PROPOSALS_LIMIT_REACHED", { text: "", byUserId: "", at: "" });
    return finish(criteria, added, voided, rejected, trace);
  }

  for (let index = 0; index < submitted.length; index += 1) {
    const raw = submitted[index];

    // 不是对象的一条：留一条拒绝记录，继续处理后面的条目。
    if (!isPlainObject(raw)) {
      reject("NOT_OBJECT", { text: proposalLabel(raw), byUserId: "", at: "" });
      continue;
    }

    const byUserId = readIdentity(raw.byUserId);
    const at = readIdentity(raw.at);
    const inspected = inspectText(raw.text);
    const text = inspected.state === "valid" ? inspected.text : undefined;
    const inspectedReason = inspectText(raw.voidReason);
    /** 留痕尽量保留负责人实际提交的原文，别让换行/制表符在记录里消失。 */
    const source = typeof raw.text === "string" ? raw.text : text;
    /** 只登记一条拒绝，调用方必须紧接着 continue；这里不改变任何条件。 */
    const fail = (reasonCode: AcceptanceDetailReasonCode): void => {
      reject(reasonCode, { text: source ?? "", byUserId: byUserId ?? "", at: at ?? "" });
    };
    /** 内容不可用：区分“没写”和“写了不可见字符”，避免把控制字符说成空。 */
    const failText = (): void => {
      fail(inspected.state === "control" ? "TEXT_CONTROL_CHARACTER" : "TEXT_MISSING");
    };

    // 不支持/写错的字段要显式拒绝，避免把打错字的 void 当成追加。
    const supportedKeys = ["text", "byUserId", "at", "void", "voidReason"];
    if (Object.keys(raw).some(key => !supportedKeys.includes(key))) {
      fail("INVALID_OPERATION");
      continue;
    }

    if (hasOwn(raw, "void") && typeof raw.void !== "boolean") {
      fail("INVALID_OPERATION");
      continue;
    }
    const isVoid = raw.void === true;

    if (isVoid) {
      // 先回答“要作废的是不是当前条件里的这一条”，再校验理由等其他字段：
      // 已经作废过的条目不该因为理由写得短而被误报成“理由不合格”。
      if (!text) {
        failText();
        continue;
      }
      if (text.length > ACCEPTANCE_DETAIL_MAX_TEXT_LENGTH) {
        fail("TEXT_TOO_LONG");
        continue;
      }
      const key = comparisonKey(text);
      const targetIndex = existingTexts.findIndex(value => comparisonKey(value) === key);
      if (targetIndex < 0) {
        fail("VOID_TARGET_NOT_FOUND");
        continue;
      }
      if (voidedKeys.has(key)) {
        fail("VOID_TARGET_ALREADY_VOIDED");
        continue;
      }
      if (typeof raw.voidReason !== "string") {
        fail("VOID_REASON_MISSING");
        continue;
      }
      const reason = inspectedReason.state === "valid" ? inspectedReason.text : undefined;
      if (!reason || reason.length < ACCEPTANCE_DETAIL_MIN_VOID_REASON_LENGTH) {
        fail("VOID_REASON_MISSING");
        continue;
      }
      if (!byUserId) {
        fail("AUTHOR_MISSING");
        continue;
      }
      if (!at) {
        fail("TIME_MISSING");
        continue;
      }
      if (!isIsoTimestamp(at)) {
        fail("TIME_INVALID");
        continue;
      }
      if (!actorMayRefine || !actorUserId || byUserId !== actorUserId) {
        fail("PERMISSION_NOT_CONFIRMED");
        continue;
      }
      const entry: AcceptanceDetailVoided = { text: existingTexts[targetIndex]!, reason, byUserId, at };
      voidedKeys.add(key);
      voided.push(entry);
      trace.push({ action: "voided", text: entry.text, byUserId, at, applied: true, reason });
      continue;
    }

    // 追加新条件
    if (!text) {
      failText();
      continue;
    }
    if (text.length > ACCEPTANCE_DETAIL_MAX_TEXT_LENGTH) {
      fail("TEXT_TOO_LONG");
      continue;
    }
    const key = comparisonKey(text);
    if (acceptedKeys.has(key)) {
      fail("DUPLICATE_CRITERION");
      continue;
    }
    if (!byUserId) {
      fail("AUTHOR_MISSING");
      continue;
    }
    if (!at) {
      fail("TIME_MISSING");
      continue;
    }
    if (!isIsoTimestamp(at)) {
      fail("TIME_INVALID");
      continue;
    }
    if (!actorMayRefine || !actorUserId || byUserId !== actorUserId) {
      fail("PERMISSION_NOT_CONFIRMED");
      continue;
    }
    if (criteria.length >= ACCEPTANCE_DETAIL_MAX_CRITERIA) {
      fail("CRITERIA_LIMIT_REACHED");
      continue;
    }

    const entry: AcceptanceDetailAccepted = { text, byUserId, at };
    criteria.push(text);
    acceptedKeys.add(key);
    added.push(entry);
    accepted.push(entry);
    trace.push({ action: "added", text, byUserId, at, applied: true });
  }

  return finish(criteria, added, voided, rejected, trace);
}

function finish(
  criteria: string[],
  added: AcceptanceDetailAccepted[],
  voided: AcceptanceDetailVoided[],
  rejected: AcceptanceDetailRejection[],
  trace: AcceptanceDetailTraceEntry[],
): AcceptanceDetailResult {
  return {
    criteria,
    added,
    voided,
    rejected,
    trace,
    summary: buildSummary(criteria, added, voided, rejected),
  };
}

/** 摘要只陈述事实：新增几条、作废几条、拒绝几条；不产生完成率或完成状态。 */
function buildSummary(
  criteria: readonly string[],
  added: readonly AcceptanceDetailAccepted[],
  voided: readonly AcceptanceDetailVoided[],
  rejected: readonly AcceptanceDetailRejection[],
): string {
  if (!added.length && !voided.length && !rejected.length) {
    return `未提交细化，检查条件保持原样（共 ${criteria.length} 条）。`;
  }
  const parts: string[] = [];
  if (added.length) parts.push(`新增 ${added.length} 条：${proposeHumanReadableList(added.map(entry => entry.text), 3)}`);
  if (voided.length) parts.push(`标注作废 ${voided.length} 条（原文与理由已保留）：${proposeHumanReadableList(voided.map(entry => entry.text), 3)}`);
  if (rejected.length) parts.push(`拒绝 ${rejected.length} 条：${proposeHumanReadableList(rejected.map(entry => entry.reason), 2)}`);
  return `检查条件共 ${criteria.length} 条，本次${parts.join("；")}。`;
}
