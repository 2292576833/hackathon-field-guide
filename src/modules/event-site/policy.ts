import {
  EVENT_SITE_BINDING_FIELD_SOURCE, EVENT_SITE_BLOCK_REGISTRY, isEventSiteActionKind, isEventSiteBlockKind,
} from "./blocks.ts";
import type { EventSiteBlockDeclaration } from "./blocks.ts";
import {
  EVENT_SITE_MAX_AI_BLOCKS, EVENT_SITE_MAX_CONTENT_BLOCKS, EVENT_SITE_MAX_IMAGE_BLOCKS, EVENT_SITE_MAX_IMAGES,
  EVENT_SITE_MAX_SPEC_BYTES, EVENT_SITE_MAX_BLOCKS,
} from "./model.ts";
import type {
  EventSiteAiContainerBlock, EventSiteBlockKind, EventSiteBlockNode, EventSiteContainerLayout,
  EventSiteDesktopCell, EventSiteDesktopRow, EventSiteDesktopSpan, EventSiteMobileCollapseGroup,
  EventSiteMobileEntry, EventSitePageLayout, EventSitePageSpec, EventSitePriority,
} from "./model.ts";
import { allowedBlockFields, jsonByteLength, normalizeSpec, textLength } from "./validation.ts";

/**
 * 规则提醒（policy）：**纯函数、不调模型、0 成本**（规划 35 §20.1）。
 *
 * 这一层与 validation 的分工：
 * - validation 是**闸门**：不合规就抛 DomainError，负责"能不能入库/发布"；
 * - policy 是**体检**：永不抛错、尽量多报，负责"编辑器里该提醒什么"。
 *   所以它容忍半成品（空区块、缺绑定、两块重叠），因为编辑到一半本来就长这样。
 *
 * 它能算出来的，绝不调用模型。这里没有任何模型、网络、时间或随机来源。
 */

export type EventSitePolicyLevel = "error" | "warning" | "info";

export interface EventSitePolicyFinding {
  readonly level: EventSitePolicyLevel;
  readonly code: string;
  /** 一句话说明（人话，不用术语，不带 ID 堆砌）。 */
  readonly message: string;
  /** 一键修复的提示；界面把它做成按钮文案。 */
  readonly fixHint: string;
  readonly blockId?: string;
}

export interface EventSitePolicySummary {
  readonly total: number;
  readonly counts: Readonly<Record<EventSitePolicyLevel, number>>;
  readonly worst: EventSitePolicyLevel | null;
}

/** 界面必须原样展示的三句口径。 */
export const eventSiteZeroCostNotice = "规则提醒全部在本地计算，不调用模型，也不产生费用。";
export const eventSiteFreeNotice = "删除只给建议、不阻止；只剩赛事名与页脚的空白页也是合法的。";
export const eventSiteMobileNotice = "手机固定单列、不横向滚动、折叠只有一层；放哪与折不折由引擎决定，这里只提醒。";

const LEVEL_WEIGHT: Readonly<Record<EventSitePolicyLevel, number>> = { error: 3, warning: 2, info: 1 };

/** 布局字段：出现在规格里就说明有人想写死几何（手机横向滚动的来源）。 */
const LAYOUT_FIELDS = new Set(["width", "height", "x", "y", "left", "top", "right", "bottom", "position", "style", "className", "px", "gap", "columns"]);

const DATE_LIKE = /(\d+\s*年\s*\d+\s*月)|(\d+\s*月\s*\d+\s*日)|(\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2})|(\d{1,2}\s*:\s*\d{2})|(\d+\s*(天|小时|分鐘|分钟|周|週))/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RawBlock {
  readonly index: number;
  readonly id: string;
  readonly kind: EventSiteBlockKind;
  readonly declaration: EventSiteBlockDeclaration;
  readonly raw: Record<string, unknown>;
}

function rawId(raw: Record<string, unknown>, index: number): string {
  const value = raw.id;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return "第" + String(index + 1) + "块";
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 体检一个**可能是半成品**的规格：永远返回数组，永远不抛错。
 *
 * 覆盖（规划 35 §20.1 提醒项）：手机不横向滚动、文案超长、区块数/图片数超限、规格体积超限、
 * 空区块、重复区块、事实类块缺少绑定、动作跳板缺失（仅提示）、AI 容器空职责/管辖为空/重叠。
 */
export function reviewSpec(input: unknown): readonly EventSitePolicyFinding[] {
  const findings: EventSitePolicyFinding[] = [];
  const add = (level: EventSitePolicyLevel, code: string, message: string, fixHint: string, blockId?: string): void => {
    findings.push(blockId === undefined
      ? { level: level, code: code, message: message, fixHint: fixHint }
      : { level: level, code: code, message: message, fixHint: fixHint, blockId: blockId });
  };

  try {
    if (!isRecord(input)) {
      add("error", "REVIEW_SPEC_INVALID", "页面规格不是一个对象，编辑器读不出这一页。", "重新加载这一页，或一键恢复默认模块集。");
      return findings;
    }

    let bytes = 0;
    try {
      bytes = jsonByteLength(input);
    } catch {
      add("error", "REVIEW_SPEC_INVALID", "页面规格里有无法序列化的内容。", "重新加载这一页，或一键恢复默认模块集。");
      return findings;
    }
    if (bytes > EVENT_SITE_MAX_SPEC_BYTES) {
      add("error", "REVIEW_SPEC_TOO_LARGE", "页面规格约 " + String(Math.round(bytes / 1024)) + "KB，超过 " + String(EVENT_SITE_MAX_SPEC_BYTES / 1024) + "KB 上限。", "删掉不用的区块，或把长文案压短。");
    }

    for (const key of Object.keys(input)) {
      if (key !== "version" && key !== "blocks" && key !== "skin") {
        add("error", "REVIEW_UNKNOWN_FIELD", "页面规格里出现了不认识的字段「" + key + "」。", "删掉这个字段；布局由引擎派生，不能写进规格。");
      }
    }
    const skinRaw = (input as { skin?: unknown }).skin;
    if (skinRaw !== undefined && skinRaw !== null
      && skinRaw !== "classic" && skinRaw !== "dark" && skinRaw !== "paper" && skinRaw !== "neon") {
      add("error", "REVIEW_UNKNOWN_SKIN", "视觉皮肤只能是平台预置的几套（classic / dark / paper / neon）。", "选一套预置皮肤；不能自定义颜色或 CSS。");
    }

    const blocksRaw = input.blocks;
    if (!Array.isArray(blocksRaw)) {
      add("error", "REVIEW_SPEC_INVALID", "页面规格缺少 blocks 数组。", "重新加载这一页，或一键恢复默认模块集。");
      return findings;
    }
    if (blocksRaw.length > EVENT_SITE_MAX_BLOCKS) {
      add("error", "REVIEW_TOO_MANY_BLOCKS", "这一页有 " + String(blocksRaw.length) + " 个区块，超过总数上限 " + String(EVENT_SITE_MAX_BLOCKS) + "。", "合并或删掉重复的区块。");
    }

    const blocks: RawBlock[] = [];
    for (let index = 0; index < blocksRaw.length; index += 1) {
      const raw = blocksRaw[index];
      const id = isRecord(raw) ? rawId(raw, index) : "第" + String(index + 1) + "块";
      if (!isRecord(raw)) {
        add("error", "REVIEW_BLOCK_INVALID", id + "的格式不对，编辑器读不出它。", "删掉这个区块重新添加一次。", id);
        continue;
      }
      if (!isEventSiteBlockKind(raw.kind)) {
        add("error", "REVIEW_UNKNOWN_BLOCK_KIND", id + "的类型「" + String(raw.kind) + "」不在区块表里。", "换成区块表里的类型，或删掉这一块。", id);
        continue;
      }
      blocks.push({ index: index, id: id, kind: raw.kind, declaration: EVENT_SITE_BLOCK_REGISTRY[raw.kind], raw: raw });
    }

    reviewEachBlock(blocks, add);
    reviewCounts(blocks, add);
    reviewDuplicates(blocks, add);
    reviewAiContainers(blocks, add);
    reviewActions(blocks, add);
  } catch (error) {
    // 体检不允许把编辑器打挂：任何意外都收敛成一条可读提醒。
    add("error", "REVIEW_SPEC_INVALID", "这一页的规格有读不出来的部分。", "重新加载这一页，或一键恢复默认模块集。");
    void error;
  }

  return findings;
}

type AddFinding = (level: EventSitePolicyLevel, code: string, message: string, fixHint: string, blockId?: string) => void;

function reviewEachBlock(blocks: readonly RawBlock[], add: AddFinding): void {
  for (const block of blocks) {
    const declaration = block.declaration;
    const raw = block.raw;

    const allowed = allowedBlockFields(declaration);
    for (const key of Object.keys(raw)) {
      if (LAYOUT_FIELDS.has(key)) {
        add("error", "REVIEW_MOBILE_FIXED_WIDTH", block.id + "上写了固定的位置或宽度（" + key + "），手机上会横向滚动。", "删掉这个字段；宽度与位置由引擎按单列算。", block.id);
        continue;
      }
      if (allowed.has(key)) continue;
      const value = raw[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      add("error", "REVIEW_UNKNOWN_FIELD", block.id + "上有这个区块不认识的字段「" + key + "」。", "删掉这个字段；它不会被渲染，也不会保存。", block.id);
    }

    const priority = raw.priority;
    if (priority !== undefined && priority !== null && (typeof priority !== "number" || !Number.isInteger(priority) || priority < 1 || priority > 5)) {
      add("warning", "REVIEW_PRIORITY_INVALID", block.id + "的重要度不是 1 到 5 的整数。", "选 1 到 5；数字越大越靠前。", block.id);
    }

    if (declaration.category === "content") {
      reviewContentBlock(block, add);
    } else if (declaration.category === "container") {
      reviewContainerBlock(block, add);
    }

    if (declaration.factClass) {
      const binding = raw.binding;
      if (binding === undefined || binding === null) {
        add("error", "REVIEW_FACT_BLOCK_MISSING_BINDING", block.id + "展示的是平台记录，但还没选数据源。", "选一个数据源（例如报名截止时间），不要手写。", block.id);
      } else if (!isRecord(binding)) {
        add("error", "REVIEW_FACT_BINDING_INVALID", block.id + "的数据源格式不对。", "重新选一次数据源。", block.id);
      } else {
        const field = stringOf(binding.field);
        const source = stringOf(binding.source);
        const known = field !== null && Object.prototype.hasOwnProperty.call(EVENT_SITE_BINDING_FIELD_SOURCE, field);
        if (!known || !declaration.allowedBindingFields.includes(field as never)) {
          add("error", "REVIEW_FACT_BINDING_INVALID", block.id + "绑定了它拿不到的事实字段「" + String(field) + "」。", "改选这个区块能拿到的字段。", block.id);
        } else if (source !== EVENT_SITE_BINDING_FIELD_SOURCE[field as never]) {
          add("error", "REVIEW_FACT_BINDING_INVALID", block.id + "的数据源与字段不匹配。", "改选与该字段一致的数据源。", block.id);
        }
      }
      const heading = stringOf(raw.heading);
      if (heading !== null && DATE_LIKE.test(heading)) {
        add("warning", "REVIEW_FACT_HEADING_LOOKS_LIKE_VALUE", block.id + "的标题里写了具体日期或时长，可能和平台记录不一致。", "标题只写一句说明（例如「距离报名截止」），时间交给绑定。", block.id);
      }
    } else if (raw.binding !== undefined && raw.binding !== null) {
      add("warning", "REVIEW_BINDING_NOT_ALLOWED", block.id + "是主办方文案区块，却声明了平台数据绑定。", "删掉绑定；事实请用倒计时、时间线或 FAQ 区块。", block.id);
    }
  }
}

function reviewContentBlock(block: RawBlock, add: AddFinding): void {
  const rules = block.declaration.textRules;
  const raw = block.raw;

  const heading = stringOf(raw.heading);
  if (heading !== null) {
    if (/[<>]/.test(heading)) {
      add("error", "REVIEW_HTML_IN_TEXT", block.id + "的标题里有 HTML 标签。", "去掉标签，只留纯文字。", block.id);
    }
    if (rules.maxHeading > 0 && textLength(heading.trim()) > rules.maxHeading) {
      add("warning", "REVIEW_TEXT_TOO_LONG", block.id + "的标题有 " + String(textLength(heading.trim())) + " 个字符，上限是 " + String(rules.maxHeading) + "。", "压到 " + String(rules.maxHeading) + " 个字符以内。", block.id);
    }
  }

  const text = stringOf(raw.text);
  if (text !== null) {
    if (/[<>]/.test(text)) {
      add("error", "REVIEW_HTML_IN_TEXT", block.id + "的文案里有 HTML 标签。", "去掉标签，只留纯文字。", block.id);
    }
    if (rules.maxText > 0 && textLength(text.trim()) > rules.maxText) {
      add("warning", "REVIEW_TEXT_TOO_LONG", block.id + "的文案有 " + String(textLength(text.trim())) + " 个字符，上限是 " + String(rules.maxText) + "。", "压到 " + String(rules.maxText) + " 个字符以内。", block.id);
    }
  }

  if (rules.requirement === "required" && (text === null || text.trim().length === 0)) {
    add("error", "REVIEW_TEXT_REQUIRED", block.id + "还没有写任何文字。", "写一句要选手知道的话。", block.id);
  }

  const items = arrayOf(raw.items);
  if (rules.maxItems > 0 && items.length > rules.maxItems) {
    add("warning", "REVIEW_TOO_MANY_ITEMS", block.id + "有 " + String(items.length) + " 条，上限是 " + String(rules.maxItems) + " 条。", "删到 " + String(rules.maxItems) + " 条以内。", block.id);
  }
  if (rules.maxItems > 0 && rules.minItems > 0 && items.length < rules.minItems) {
    add("warning", "REVIEW_BLOCK_EMPTY", block.id + "还是空的。", "至少加 " + String(rules.minItems) + " 条内容，或者删掉这块。", block.id);
  }
  const hasAnyText = (heading !== null && heading.trim().length > 0) || (text !== null && text.trim().length > 0);
  const hasImage = isRecord(raw.image) || items.some(entry => isRecord(entry) && isRecord(entry.image));
  if (rules.requirement === "optional" && rules.maxItems === 0 && !hasAnyText && !hasImage && block.declaration.requiresImage) {
    add("warning", "REVIEW_BLOCK_EMPTY", block.id + "还没有选图片。", "上传或选一张图，或者删掉这块。", block.id);
  }
}

function reviewContainerBlock(block: RawBlock, add: AddFinding): void {
  const raw = block.raw;
  const manages = raw.manages;
  if (manages === undefined || manages === null || (Array.isArray(manages) && manages.length === 0)) {
    add("error", "REVIEW_AI_SCOPE_EMPTY", block.id + "还没有框住任何区块。", "把要它管的块拖进框里，或者删掉这个 AI 组件。", block.id);
  } else if (!Array.isArray(manages)) {
    add("error", "REVIEW_AI_SCOPE_EMPTY", block.id + "的管辖范围格式不对。", "重新框选一次要它管的块。", block.id);
  }
  const duty = stringOf(raw.duty);
  if (duty === null || duty.trim().length === 0) {
    add("info", "REVIEW_AI_DUTY_EMPTY", block.id + "还没有写职责，它不会产生任何调用。", "写一行「这块你只管…」，例如「只回答报名条件与材料要求」。", block.id);
  }
  const mode = raw.mode;
  if (mode !== undefined && mode !== null && mode !== "edit") {
    add("warning", "REVIEW_AI_MODE_UNSUPPORTED", block.id + "用了问答模式，本期不可用。", "切成编辑模式；问答模式须先单独立项。", block.id);
  }
}

function reviewCounts(blocks: readonly RawBlock[], add: AddFinding): void {
  const content = blocks.filter(block => block.declaration.category === "content");
  if (content.length > EVENT_SITE_MAX_CONTENT_BLOCKS) {
    add("error", "REVIEW_TOO_MANY_BLOCKS", "内容区块有 " + String(content.length) + " 个，上限是 " + String(EVENT_SITE_MAX_CONTENT_BLOCKS) + " 个。", "合并或删掉不用的内容区块。");
  }
  const imageBlocks = content.filter(block => block.declaration.carriesImage);
  if (imageBlocks.length > EVENT_SITE_MAX_IMAGE_BLOCKS) {
    add("error", "REVIEW_TOO_MANY_IMAGE_BLOCKS", "图片区块有 " + String(imageBlocks.length) + " 个，上限是 " + String(EVENT_SITE_MAX_IMAGE_BLOCKS) + " 个。", "把几张图并进一个赞助商墙或人物墙。");
  }
  let images = 0;
  for (const block of blocks) {
    if (block.declaration.category !== "content") continue;
    if (isRecord(block.raw.image)) images += 1;
    for (const item of arrayOf(block.raw.items)) {
      if (isRecord(item) && isRecord(item.image)) images += 1;
    }
  }
  if (images > EVENT_SITE_MAX_IMAGES) {
    add("warning", "REVIEW_TOO_MANY_IMAGES", "这一页引用了 " + String(images) + " 张图片，上限是 " + String(EVENT_SITE_MAX_IMAGES) + " 张。", "删掉几张不重要的图片。");
  }
}

function signatureOf(block: RawBlock): string {
  if (block.declaration.category === "action") return block.kind;
  if (block.declaration.factClass) {
    const binding = isRecord(block.raw.binding) ? stringOf(block.raw.binding.field) : null;
    return block.kind + "|" + String(binding);
  }
  const heading = stringOf(block.raw.heading) ?? "";
  const text = stringOf(block.raw.text) ?? "";
  const items = arrayOf(block.raw.items).map(entry => (isRecord(entry) ? String(entry.heading ?? "") : "")).join("|");
  return block.kind + "|" + heading.trim() + "|" + text.trim() + "|" + items;
}

function reviewDuplicates(blocks: readonly RawBlock[], add: AddFinding): void {
  const seen = new Map<string, string>();
  for (const block of blocks) {
    if (block.declaration.category === "container") continue;
    const signature = signatureOf(block);
    const first = seen.get(signature);
    if (first === undefined) {
      seen.set(signature, block.id);
      continue;
    }
    add("info", "REVIEW_DUPLICATE_BLOCK", block.id + "和 " + first + "的内容看起来重复了。", "合并成一块，或删掉其中一块。", block.id);
  }
}

function reviewAiContainers(blocks: readonly RawBlock[], add: AddFinding): void {
  const containers = blocks.filter(block => block.declaration.category === "container");
  if (containers.length > EVENT_SITE_MAX_AI_BLOCKS) {
    add("error", "REVIEW_AI_TOO_MANY", "这一页有 " + String(containers.length) + " 个 AI 组件，上限是 " + String(EVENT_SITE_MAX_AI_BLOCKS) + " 个。", "合并成一个 AI 组件，让它管更多块。");
  }
  const byId = new Map<string, RawBlock>();
  for (const block of blocks) byId.set(block.id, block);
  const owner = new Map<string, string>();
  for (const container of containers) {
    for (const managed of arrayOf(container.raw.manages)) {
      if (typeof managed !== "string") continue;
      if (managed === container.id) {
        add("error", "REVIEW_AI_SCOPE_SELF", container.id + "把自己框进去了。", "去掉它自己；AI 组件不能管自己。", container.id);
        continue;
      }
      const target = byId.get(managed);
      if (target === undefined) {
        add("error", "REVIEW_AI_SCOPE_UNKNOWN_BLOCK", container.id + "管辖的区块「" + managed + "」不在这一页上。", "重新框选，或删掉这个引用的块。", container.id);
        continue;
      }
      if (target.declaration.category === "container") {
        add("error", "REVIEW_AI_CONTAINER_NESTED", container.id + "把另一个 AI 组件框进去了。", "AI 组件不能嵌套，把容器移出框外。", container.id);
        continue;
      }
      if (isEventSiteActionKind(target.kind)) {
        add("error", "REVIEW_AI_SCOPE_ACTION_NOT_ALLOWED", container.id + "把动作跳板「" + managed + "」框进去了。", "动作跳板不归 AI 管；把它移出框外。", container.id);
        continue;
      }
      const existing = owner.get(managed);
      if (existing !== undefined && existing !== container.id) {
        add("error", "REVIEW_AI_SCOPE_OVERLAP", "区块「" + managed + "」同时被 " + existing + " 和 " + container.id + " 管辖。", "一块只能属于一个 AI 组件，把其中一处移出。", container.id);
        continue;
      }
      owner.set(managed, container.id);
      if (container.raw.collapse === true && target.raw.collapse === true) {
        add("error", "REVIEW_NESTED_COLLAPSE", container.id + "和它框住的 " + managed + " 都设了手机折叠，折叠只能一层。", "只保留外层折叠，把里面的折叠关掉。", container.id);
      }
    }
  }
}

function reviewActions(blocks: readonly RawBlock[], add: AddFinding): void {
  const kinds = new Set(blocks.filter(block => block.declaration.category === "action").map(block => block.kind));
  if (!kinds.has("actionRegister")) {
    add("info", "REVIEW_ACTION_MISSING", "这一页没有「报名」入口。", "加一个报名跳板；不加也能保存与发布，只是选手要多点一次才能找到报名页。");
  }
  if (!kinds.has("actionSubmit")) {
    add("info", "REVIEW_ACTION_MISSING", "这一页没有「提交」入口。", "加一个提交跳板；不加也能保存与发布，只是选手要多点一次才能找到提交页。");
  }
}

/** 只取最严重的几条（编辑中只报 1–2 条，规划 35 §20.2）。 */
export function topFindings(findings: readonly EventSitePolicyFinding[], limit = 2): readonly EventSitePolicyFinding[] {
  return [...findings]
    .map((finding, index) => ({ finding: finding, index: index }))
    .sort((left, right) => (LEVEL_WEIGHT[right.finding.level] - LEVEL_WEIGHT[left.finding.level]) || (left.index - right.index))
    .slice(0, Math.max(0, limit))
    .map(entry => entry.finding);
}

/** 体检结论汇总（界面显示"建议条 3 条"用）。 */
export function summarizeFindings(findings: readonly EventSitePolicyFinding[]): EventSitePolicySummary {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.level] += 1;
  const worst: EventSitePolicyLevel | null = counts.error > 0 ? "error" : counts.warning > 0 ? "warning" : counts.info > 0 ? "info" : null;
  return { total: findings.length, counts: counts, worst: worst };
}

/* ------------------------------------------------------------------ *
 * 优先级派生（规划 35 §3、§7）
 * ------------------------------------------------------------------ */

/** 重要度对应的桌面列宽基线；变体可以强制整行。 */
const BASE_SPAN: Readonly<Record<EventSitePriority, EventSiteDesktopSpan>> = { 5: 12, 4: 8, 3: 6, 2: 4, 1: 3 };

export const EVENT_SITE_LAYOUT_CONSTRAINTS = Object.freeze({
  fixedWidth: false as const,
  absolutePosition: false as const,
  horizontalScroll: false as const,
  collapseDepth: 1 as const,
  breakpoints: [620, 760, 1024] as const,
});

function spanOf(block: EventSiteBlockNode): EventSiteDesktopSpan {
  const declaration = EVENT_SITE_BLOCK_REGISTRY[block.kind];
  if (declaration.fullWidthVariants.includes(block.variant)) return 12;
  return BASE_SPAN[block.priority];
}

/**
 * 把语义层派生成布局层：**只出数据，不做样式**。
 *
 * - 桌面：12 列栅格，列宽只允许 3/4/6/8/12 四档；整行变体独占一行。
 * - 手机：单列，顺序按 priority 从大到小（同级保持原顺序）。
 * - 折叠：只把手机顺序里**相邻**的折叠块合成一组；嵌套折叠在校验阶段已被拒绝。
 * - 容器不是布局盒，是作用域：单独列出，不占栅格。
 */
export function deriveLayout(spec: EventSitePageSpec): EventSitePageLayout {
  // 派生前先归一：渲染器拿到的不一定是刚校验过的对象，缺省字段在这里补齐，避免 NaN 列宽。
  const normalized = normalizeSpec(spec);
  const blocks = normalized.blocks.filter((block): block is Exclude<EventSiteBlockNode, EventSiteAiContainerBlock> => block.kind !== "aiBlock");
  const containers: EventSiteContainerLayout[] = normalized.blocks
    .filter((block): block is EventSiteAiContainerBlock => block.kind === "aiBlock")
    .map(block => ({
      containerId: block.id,
      manages: block.manages,
      mode: block.mode,
      scope: block.fullPage ? "page" : "blocks",
    }));

  const rows: EventSiteDesktopRow[] = [];
  let current: EventSiteDesktopCell[] = [];
  let used = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    rows.push({ index: rows.length, cells: current });
    current = [];
    used = 0;
  };
  for (const block of blocks) {
    const span = spanOf(block);
    if (span === 12) {
      flush();
      rows.push({ index: rows.length, cells: [{ blockId: block.id, span: 12 }] });
      continue;
    }
    if (used + span > 12) flush();
    current.push({ blockId: block.id, span: span });
    used += span;
  }
  flush();

  const ordered = blocks
    .map((block, index) => ({ block: block, index: index }))
    .sort((left, right) => (right.block.priority - left.block.priority) || (left.index - right.index))
    .map(entry => entry.block);

  const entries: EventSiteMobileEntry[] = [];
  const groups: EventSiteMobileCollapseGroup[] = [];
  let openGroup: { id: string; blockIds: string[] } | null = null;
  for (const block of ordered) {
    if (block.collapse) {
      if (openGroup === null) {
        openGroup = { id: "g" + String(groups.length + 1), blockIds: [] };
        groups.push({ id: openGroup.id, blockIds: openGroup.blockIds });
      }
      openGroup.blockIds.push(block.id);
      entries.push({ blockId: block.id, order: entries.length, collapsed: true, groupId: openGroup.id });
      continue;
    }
    openGroup = null;
    entries.push({ blockId: block.id, order: entries.length, collapsed: false, groupId: null });
  }

  return {
    grid: { columns: 12, rows: rows },
    containers: containers,
    mobile: { columns: 1, entries: entries, collapseGroups: groups },
    constraints: EVENT_SITE_LAYOUT_CONSTRAINTS,
  };
}
