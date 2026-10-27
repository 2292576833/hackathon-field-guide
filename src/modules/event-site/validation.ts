import { DomainError } from "../../shared/errors.ts";
import {
  EVENT_SITE_BINDING_FIELD_SOURCE, EVENT_SITE_BLOCK_REGISTRY, EVENT_SITE_DEFAULT_PRIORITY, blockDeclaration,
  isActionBlock, isEventSiteActionKind, isEventSiteBlockKind,
} from "./blocks.ts";
import type { EventSiteBlockDeclaration } from "./blocks.ts";
import {
  EVENT_SITE_MAX_AI_BLOCKS, EVENT_SITE_MAX_BLOCKS, EVENT_SITE_MAX_BLOCK_ID, EVENT_SITE_MAX_CONTENT_BLOCKS,
  EVENT_SITE_MAX_DUTY, EVENT_SITE_MAX_IMAGE_BLOCKS, EVENT_SITE_MAX_IMAGES, EVENT_SITE_MAX_MANAGES,
  EVENT_SITE_MAX_SPEC_BYTES,
} from "./model.ts";
import type {
  EventSiteActionBlock, EventSiteAiContainerBlock, EventSiteBinding, EventSiteBindingField,
  EventSiteBlock, EventSiteBlockNode, EventSiteContentBlockKind, EventSiteImageAspect, EventSiteImageRef,
  EventSiteItem, EventSitePageSpec, EventSitePriority, EventSiteSkin,
} from "./model.ts";

/**
 * 规格校验与归一（规划 35 §3、§4、§7、§13；宪法 XIV）。
 *
 * 两条入口，**都拒绝**未知 kind、未知字段与超限值：
 * - parseSpec：严格形态。区块必须带 id / kind / variant / priority / collapse，缺一即拒绝。
 * - normalizeSpec：宽容形态。缺省字段按注册表补默认值（id 由序号派生），其余校验与 parseSpec 完全一致。
 *
 * 所有错误都是 DomainError 并带明确 code（见 README「错误码」）。这里不写库、不读库、不调模型。
 */

export const EVENT_SITE_SPEC_VERSION = 1;

/** 图片允许的宽高比（规划 35 §7 第 3 条）。 */
const ASPECTS: readonly EventSiteImageAspect[] = ["16:9", "4:3", "1:1", "3:4"];

/** 不可见控制字符（保留 tab / 换行 / 回车）。 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const BLOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** 规格根对象允许的字段（其余一律拒绝，防夹带布局/脚本字段）。 */
const SPEC_FIELDS = new Set(["version", "blocks", "skin"]);
/** 所有区块共有的字段。 */
const COMMON_FIELDS = new Set(["id", "kind", "variant", "priority", "collapse"]);
/** 容器独有字段。 */
const CONTAINER_FIELDS = new Set(["manages", "duty", "mode", "fullPage"]);
/** 事实类区块里"会变成第二份事实"的字段名。 */
const FACT_VALUE_FIELDS = new Set(["text", "items", "image", "value", "date", "label"]);
/** 动作跳板绝不允许携带跳转地址或表单字段（第二条写路径）。 */
const ACTION_REDIRECT_FIELDS = new Set(["href", "url", "to", "route", "target", "form", "endpoint", "actionUrl"]);

type ReadMode = "strict" | "normalize";

function fail(code: string, message: string, status = 422): never {
  throw new DomainError(code, message, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 规格的 UTF-8 字节数（128KB 上限与规则提醒共用这一份实现）。 */
export function jsonByteLength(value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch {
    fail("EVENT_SITE_INVALID_SPEC", "页面规格不是可序列化的对象。");
  }
  return new TextEncoder().encode(json).length;
}

/** 纯文本字符数（按字符计数，不按字节，避免中文被字节数误伤）。 */
export function textLength(value: string): number {
  return Array.from(value).length;
}

function textField(value: unknown, label: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) fail("EVENT_SITE_TEXT_REQUIRED", label + "不能为空。");
    return null;
  }
  if (typeof value !== "string") fail("EVENT_SITE_INVALID_TEXT", label + "必须是纯文本字符串。");
  if (/[<>]/.test(value)) fail("EVENT_SITE_HTML_NOT_ALLOWED", label + "只能是纯文本，不能包含 HTML 标签。");
  if (CONTROL_CHARACTERS.test(value)) fail("EVENT_SITE_INVALID_TEXT", label + "包含不可见控制字符。");
  const trimmed = value.trim();
  const length = textLength(trimmed);
  if (length > max) {
    fail("EVENT_SITE_TEXT_TOO_LONG", label + "最多 " + String(max) + " 个字符，当前 " + String(length) + " 个。");
  }
  if (length === 0) {
    if (required) fail("EVENT_SITE_TEXT_REQUIRED", label + "不能为空。");
    return null;
  }
  return trimmed;
}

function blockIdField(value: unknown, label: string): string {
  if (typeof value !== "string") fail("EVENT_SITE_INVALID_BLOCK_ID", label + "必须是字符串。");
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EVENT_SITE_MAX_BLOCK_ID || !BLOCK_ID_PATTERN.test(trimmed)) {
    fail("EVENT_SITE_INVALID_BLOCK_ID", label + "只能用英文字母、数字、下划线与连字符，且不超过 " + String(EVENT_SITE_MAX_BLOCK_ID) + " 个字符。");
  }
  return trimmed;
}

function priorityField(value: unknown): EventSitePriority {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    fail("EVENT_SITE_INVALID_PRIORITY", "重要度必须是 1 到 5 的整数。");
  }
  return value as EventSitePriority;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail("EVENT_SITE_INVALID_SPEC", label + "必须是布尔值。");
  return value;
}

function variantField(declaration: EventSiteBlockDeclaration, value: unknown, fallback: string | null): string {
  if (value === undefined || value === null) {
    if (fallback === null) fail("EVENT_SITE_UNKNOWN_VARIANT", declaration.label + "必须指定变体。");
    return fallback;
  }
  if (typeof value !== "string" || !declaration.variants.includes(value)) {
    fail("EVENT_SITE_UNKNOWN_VARIANT", declaration.label + "不支持变体「" + String(value) + "」，可选：" + declaration.variants.join(" / ") + "。");
  }
  return value;
}

/** 严格形态必须给；宽容形态补默认值。 */
function variantForMode(declaration: EventSiteBlockDeclaration, value: unknown, mode: ReadMode): string {
  return variantField(declaration, value, mode === "strict" ? null : declaration.defaultVariant);
}

function priorityForMode(value: unknown, mode: ReadMode): EventSitePriority {
  if ((value === undefined || value === null) && mode === "normalize") return EVENT_SITE_DEFAULT_PRIORITY;
  return priorityField(value);
}

function collapseForMode(value: unknown, mode: ReadMode): boolean {
  if (value === undefined || value === null) {
    if (mode === "normalize") return false;
    fail("EVENT_SITE_INVALID_SPEC", "区块缺少 collapse 字段；手机是否折叠必须显式给出。");
  }
  return booleanField(value, "手机折叠");
}

function imageField(value: unknown, label: string, required: boolean): EventSiteImageRef | null {
  if (value === undefined || value === null) {
    if (required) fail("EVENT_SITE_IMAGE_REQUIRED", label + "需要一张图片。");
    return null;
  }
  if (!isRecord(value)) fail("EVENT_SITE_IMAGE_INVALID", label + "的图片引用格式不正确。");
  for (const key of Object.keys(value)) {
    if (key !== "assetId" && key !== "alt" && key !== "aspect") {
      fail("EVENT_SITE_UNKNOWN_BLOCK_FIELD", label + "的图片不接受字段「" + key + "」。");
    }
  }
  const assetId = value.assetId;
  if (typeof assetId !== "string" || assetId.length === 0 || assetId.length > 200 || !ASSET_ID_PATTERN.test(assetId)) {
    fail("EVENT_SITE_IMAGE_INVALID", label + "的图片编号格式不正确。");
  }
  const alt = textField(value.alt, label + "的替代文本", 120, true);
  const aspect = value.aspect;
  if (typeof aspect !== "string" || !ASPECTS.includes(aspect as EventSiteImageAspect)) {
    fail("EVENT_SITE_IMAGE_INVALID", label + "的图片宽高比只能是 " + ASPECTS.join(" / ") + "。");
  }
  return { assetId: assetId, alt: alt as string, aspect: aspect as EventSiteImageAspect };
}

function itemsField(value: unknown, declaration: EventSiteBlockDeclaration): readonly EventSiteItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("EVENT_SITE_ITEM_INVALID", declaration.label + "的条目必须是数组。");
  if (value.length > declaration.textRules.maxItems) {
    fail("EVENT_SITE_TOO_MANY_ITEMS", declaration.label + "最多 " + String(declaration.textRules.maxItems) + " 条，当前 " + String(value.length) + " 条。");
  }
  const items: EventSiteItem[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const label = declaration.label + "第 " + String(index + 1) + " 条";
    if (!isRecord(entry)) fail("EVENT_SITE_ITEM_INVALID", label + "格式不正确。");
    for (const key of Object.keys(entry)) {
      // 与区块级一致：null/undefined 视为缺省。parseSpec 总会写 image:null，
      // 若这里按「出现即拒绝」处理，带条目的规格就无法被 normalizeSpec/serializeSpec/deriveLayout 再接受。
      const value = (entry as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue;
      const allowed = key === "heading" || key === "text" || (key === "image" && declaration.itemImage);
      if (!allowed) fail("EVENT_SITE_UNKNOWN_BLOCK_FIELD", label + "不接受字段「" + key + "」。");
    }
    const heading = textField(entry.heading, label + "的标题", declaration.textRules.maxItemHeading, true) as string;
    const text = textField(entry.text, label + "的说明", declaration.textRules.maxItemText, false);
    const image = declaration.itemImage ? imageField(entry.image, label, false) : null;
    items.push({ heading: heading, text: text, image: image });
  }
  return items;
}

function bindingField(value: unknown, declaration: EventSiteBlockDeclaration): EventSiteBinding | null {
  if (value === undefined || value === null) {
    if (declaration.requiresBinding) {
      fail("EVENT_SITE_BINDING_REQUIRED", declaration.label + "展示的是平台记录，必须用 binding 指定数据源，不能手写。");
    }
    return null;
  }
  if (!declaration.requiresBinding) {
    fail("EVENT_SITE_BINDING_NOT_ALLOWED", declaration.label + "是主办方文案区块，不能声明平台数据绑定。");
  }
  if (!isRecord(value)) fail("EVENT_SITE_BINDING_INVALID", declaration.label + "的数据绑定格式不正确。");
  for (const key of Object.keys(value)) {
    if (key !== "source" && key !== "field") {
      fail("EVENT_SITE_UNKNOWN_BLOCK_FIELD", declaration.label + "的数据绑定不接受字段「" + key + "」。");
    }
  }
  const field = value.field;
  if (typeof field !== "string" || !Object.prototype.hasOwnProperty.call(EVENT_SITE_BINDING_FIELD_SOURCE, field)) {
    fail("EVENT_SITE_BINDING_INVALID", declaration.label + "绑定了不存在的事实字段「" + String(field) + "」。");
  }
  const bindingKey = field as EventSiteBindingField;
  if (!declaration.allowedBindingFields.includes(bindingKey)) {
    fail("EVENT_SITE_BINDING_INVALID", declaration.label + "不能绑定「" + bindingKey + "」，可绑定：" + declaration.allowedBindingFields.join(" / ") + "。");
  }
  const source = value.source;
  const expectedSource = EVENT_SITE_BINDING_FIELD_SOURCE[bindingKey];
  if (typeof source !== "string" || source !== expectedSource) {
    fail("EVENT_SITE_BINDING_INVALID", "数据源「" + String(source) + "」与字段「" + bindingKey + "」不匹配，应使用「" + expectedSource + "」。");
  }
  return { source: expectedSource, field: bindingKey };
}

/** 该区块类型接受的字段集合；校验与体检共用这一份（不允许两处各写一套）。 */
export function allowedBlockFields(declaration: EventSiteBlockDeclaration): Set<string> {
  const allowed = new Set(COMMON_FIELDS);
  if (declaration.category === "content") {
    if (declaration.textRules.maxHeading > 0) allowed.add("heading");
    if (declaration.textRules.maxText > 0) allowed.add("text");
    if (declaration.textRules.maxItems > 0) allowed.add("items");
    if (declaration.carriesImage) allowed.add("image");
    if (declaration.requiresBinding) allowed.add("binding");
  } else if (declaration.category === "action") {
    allowed.add("action");
  } else {
    for (const field of CONTAINER_FIELDS) allowed.add(field);
  }
  return allowed;
}

function rejectUnknownFields(raw: Record<string, unknown>, declaration: EventSiteBlockDeclaration): void {
  const allowed = allowedBlockFields(declaration);
  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) continue;
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (declaration.category === "action") {
      if (ACTION_REDIRECT_FIELDS.has(key)) {
        fail("EVENT_SITE_ACTION_TARGET_IMMUTABLE", declaration.label + "只能跳到平台功能页，不能自定义跳转地址或表单字段。");
      }
      fail("EVENT_SITE_UNKNOWN_BLOCK_FIELD", declaration.label + "不接受字段「" + key + "」。");
    }
    if (key === "binding") {
      fail("EVENT_SITE_BINDING_NOT_ALLOWED", declaration.label + "不能声明平台数据绑定。");
    }
    if (declaration.factClass && FACT_VALUE_FIELDS.has(key)) {
      fail("EVENT_SITE_FACT_VALUE_NOT_ALLOWED", declaration.label + "展示的是平台记录，不能手写「" + key + "」；请改用 binding 指定数据源。");
    }
    fail("EVENT_SITE_UNKNOWN_BLOCK_FIELD", declaration.label + "不接受字段「" + key + "」。");
  }
}

function readContentBlock(raw: Record<string, unknown>, declaration: EventSiteBlockDeclaration, id: string, mode: ReadMode): EventSiteBlock {
  const variant = variantForMode(declaration, raw.variant, mode);
  const priority = priorityForMode(raw.priority, mode);
  const collapse = collapseForMode(raw.collapse, mode);
  const heading = declaration.textRules.maxHeading > 0
    ? textField(raw.heading, declaration.label + "的标题", declaration.textRules.maxHeading, false)
    : null;
  const text = declaration.textRules.maxText > 0
    ? textField(raw.text, declaration.label + "的文案", declaration.textRules.maxText, declaration.textRules.requirement === "required")
    : null;
  const items = declaration.textRules.maxItems > 0 ? itemsField(raw.items, declaration) : [];
  const image = declaration.carriesImage ? imageField(raw.image, declaration.label, declaration.requiresImage) : null;
  const binding = bindingField(raw.binding, declaration);
  return {
    kind: declaration.kind as EventSiteContentBlockKind,
    id: id, variant: variant, priority: priority, collapse: collapse,
    heading: heading, text: text, items: items, image: image, binding: binding,
  };
}

function readActionBlock(raw: Record<string, unknown>, declaration: EventSiteBlockDeclaration, id: string, mode: ReadMode): EventSiteActionBlock {
  const expected = declaration.actionTarget as EventSiteActionBlock["action"];
  if (raw.action !== undefined && raw.action !== null && raw.action !== expected) {
    fail("EVENT_SITE_ACTION_TARGET_IMMUTABLE", declaration.label + "的目标由平台固定为「" + expected + "」，不能改成「" + String(raw.action) + "」。");
  }
  return {
    kind: declaration.kind as EventSiteActionBlock["kind"],
    id: id,
    variant: variantForMode(declaration, raw.variant, mode),
    priority: priorityForMode(raw.priority, mode),
    collapse: collapseForMode(raw.collapse, mode),
    action: expected,
  };
}

function managesField(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) {
    fail("EVENT_SITE_AI_SCOPE_EMPTY", label + "还没有框住任何区块，请先把要它管的块放进来。");
  }
  if (!Array.isArray(value)) fail("EVENT_SITE_AI_SCOPE_EMPTY", label + "的管辖范围必须是区块编号数组。");
  if (value.length === 0) fail("EVENT_SITE_AI_SCOPE_EMPTY", label + "还没有框住任何区块，请先把要它管的块放进来。");
  if (value.length > EVENT_SITE_MAX_MANAGES) {
    fail("EVENT_SITE_TOO_MANY_BLOCKS", label + "最多管辖 " + String(EVENT_SITE_MAX_MANAGES) + " 个区块。");
  }
  const seen = new Set<string>();
  const manages: string[] = [];
  for (const entry of value) {
    const blockId = blockIdField(entry, label + "管辖的区块编号");
    if (seen.has(blockId)) fail("EVENT_SITE_AI_SCOPE_OVERLAP", label + "重复管辖了区块「" + blockId + "」。");
    seen.add(blockId);
    manages.push(blockId);
  }
  return manages;
}

function readContainerBlock(raw: Record<string, unknown>, declaration: EventSiteBlockDeclaration, id: string, mode: ReadMode): EventSiteAiContainerBlock {
  const variant = variantForMode(declaration, raw.variant, mode);
  const priority = priorityForMode(raw.priority, mode);
  const collapse = collapseForMode(raw.collapse, mode);
  const manages = managesField(raw.manages, declaration.label + "「" + id + "」");
  const duty = textField(raw.duty, "AI 组件的职责描述", EVENT_SITE_MAX_DUTY, false);
  const mode_ = raw.mode === undefined || raw.mode === null ? "edit" : raw.mode;
  if (mode_ !== "edit") {
    fail("EVENT_SITE_AI_MODE_UNSUPPORTED", "AI 组件本期只支持编辑模式；问答模式会让 AI 对选手说话，须先单独立项。");
  }
  const fullPage = raw.fullPage === undefined || raw.fullPage === null ? false : booleanField(raw.fullPage, "整页模式");
  return {
    kind: "aiBlock", id: id, variant: variant, priority: priority, collapse: collapse,
    manages: manages, duty: duty, mode: "edit", fullPage: fullPage,
  };
}

function readBlock(raw: unknown, index: number, mode: ReadMode): EventSiteBlockNode {
  const position = "第 " + String(index + 1) + " 个区块";
  if (!isRecord(raw)) fail("EVENT_SITE_INVALID_SPEC", position + "格式不正确。");
  if (!isEventSiteBlockKind(raw.kind)) {
    fail("EVENT_SITE_UNKNOWN_BLOCK_KIND", position + "的类型「" + String(raw.kind) + "」不在区块注册表里。");
  }
  const declaration = blockDeclaration(raw.kind);
  let id: string;
  if (raw.id === undefined || raw.id === null) {
    if (mode === "strict") fail("EVENT_SITE_INVALID_BLOCK_ID", position + "缺少区块编号。");
    id = "b" + String(index + 1);
  } else {
    id = blockIdField(raw.id, position + "的编号");
  }
  rejectUnknownFields(raw, declaration);
  if (declaration.category === "content") return readContentBlock(raw, declaration, id, mode);
  if (declaration.category === "action") return readActionBlock(raw, declaration, id, mode);
  return readContainerBlock(raw, declaration, id, mode);
}

function readBlocks(value: unknown, mode: ReadMode): readonly EventSiteBlockNode[] {
  if (!Array.isArray(value)) fail("EVENT_SITE_INVALID_SPEC", "页面规格必须包含 blocks 数组。");
  if (value.length > EVENT_SITE_MAX_BLOCKS) {
    fail("EVENT_SITE_TOO_MANY_BLOCKS", "一页最多 " + String(EVENT_SITE_MAX_BLOCKS) + " 个区块，当前 " + String(value.length) + " 个。");
  }
  return value.map((entry, index) => readBlock(entry, index, mode));
}

function countImages(blocks: readonly EventSiteBlockNode[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.kind === "aiBlock") continue;
    if (isActionBlock(block)) continue;
    if (block.image !== null) total += 1;
    for (const item of block.items) if (item.image !== null) total += 1;
  }
  return total;
}

function crossBlockRules(blocks: readonly EventSiteBlockNode[]): void {
  const byId = new Map<string, EventSiteBlockNode>();
  for (const block of blocks) {
    if (byId.has(block.id)) fail("EVENT_SITE_DUPLICATE_BLOCK_ID", "区块编号「" + block.id + "」重复了，每个区块要有唯一编号。");
    byId.set(block.id, block);
  }

  const contentBlocks = blocks.filter(block => EVENT_SITE_BLOCK_REGISTRY[block.kind].category === "content");
  if (contentBlocks.length > EVENT_SITE_MAX_CONTENT_BLOCKS) {
    fail("EVENT_SITE_TOO_MANY_BLOCKS", "内容区块最多 " + String(EVENT_SITE_MAX_CONTENT_BLOCKS) + " 个，当前 " + String(contentBlocks.length) + " 个。");
  }
  const imageBlocks = contentBlocks.filter(block => EVENT_SITE_BLOCK_REGISTRY[block.kind].carriesImage);
  if (imageBlocks.length > EVENT_SITE_MAX_IMAGE_BLOCKS) {
    fail("EVENT_SITE_TOO_MANY_IMAGE_BLOCKS", "图片区块最多 " + String(EVENT_SITE_MAX_IMAGE_BLOCKS) + " 个，当前 " + String(imageBlocks.length) + " 个。");
  }
  const images = countImages(blocks);
  if (images > EVENT_SITE_MAX_IMAGES) {
    fail("EVENT_SITE_TOO_MANY_IMAGES", "一页最多引用 " + String(EVENT_SITE_MAX_IMAGES) + " 张图片，当前 " + String(images) + " 张。");
  }

  const containers = blocks.filter((block): block is EventSiteAiContainerBlock => block.kind === "aiBlock");
  if (containers.length > EVENT_SITE_MAX_AI_BLOCKS) {
    fail("EVENT_SITE_AI_TOO_MANY", "一页最多 " + String(EVENT_SITE_MAX_AI_BLOCKS) + " 个 AI 组件，当前 " + String(containers.length) + " 个。");
  }
  // 整页模式先判：两个整页容器必然互相重叠，先说清"只能一个"，比报重叠更好懂。
  const fullPages = containers.filter(container => container.fullPage);
  if (fullPages.length > 1) fail("EVENT_SITE_AI_FULL_PAGE_CONFLICT", "一页最多只能有一个整页模式的 AI 组件。");
  if (fullPages.length === 1) {
    const required = new Set(contentBlocks.map(block => block.id));
    const actual = new Set(fullPages[0].manages);
    const missing = [...required].filter(id => !actual.has(id));
    const extra = [...actual].filter(id => !required.has(id));
    if (missing.length > 0 || extra.length > 0) {
      fail("EVENT_SITE_AI_FULL_PAGE_SCOPE", "整页模式的 AI 组件必须刚好管辖本页全部内容区块"
        + (missing.length > 0 ? "，缺少：" + missing.join(" / ") : "")
        + (extra.length > 0 ? "，多出：" + extra.join(" / ") : "") + "。");
    }
  }
  const owner = new Map<string, string>();
  for (const container of containers) {
    for (const managedId of container.manages) {
      if (managedId === container.id) {
        fail("EVENT_SITE_AI_SCOPE_SELF", "AI 组件「" + container.id + "」不能管辖它自己。");
      }
      const target = byId.get(managedId);
      if (target === undefined) {
        fail("EVENT_SITE_AI_SCOPE_UNKNOWN_BLOCK", "AI 组件「" + container.id + "」管辖的区块「" + managedId + "」不在这一页上。");
      }
      if (target.kind === "aiBlock") {
        fail("EVENT_SITE_AI_CONTAINER_NESTED", "AI 组件不能嵌套容器：「" + managedId + "」也是一个 AI 组件。");
      }
      if (isEventSiteActionKind(target.kind)) {
        fail("EVENT_SITE_AI_SCOPE_ACTION_NOT_ALLOWED", "动作跳板不归 AI 组件管：它没有文案，只能由平台固定跳转。");
      }
      const existing = owner.get(managedId);
      if (existing !== undefined) {
        fail("EVENT_SITE_AI_SCOPE_OVERLAP", "区块「" + managedId + "」同时被「" + existing + "」与「" + container.id + "」管辖；一块只能属于一个 AI 组件。");
      }
      owner.set(managedId, container.id);
    }
  }
  for (const container of containers) {
    if (!container.collapse) continue;
    for (const managedId of container.manages) {
      const target = byId.get(managedId);
      if (target !== undefined && target.collapse) {
        fail("EVENT_SITE_NESTED_COLLAPSE", "手机折叠只允许一层：「" + container.id + "」已折叠，里面的「" + managedId + "」不能再折叠。");
      }
    }
  }
}

function read(input: unknown, mode: ReadMode): EventSitePageSpec {
  if (jsonByteLength(input) > EVENT_SITE_MAX_SPEC_BYTES) {
    fail("EVENT_SITE_SPEC_TOO_LARGE", "页面规格超过 " + String(EVENT_SITE_MAX_SPEC_BYTES / 1024) + "KB 上限，请减少区块或精简文案。", 413);
  }
  if (!isRecord(input)) fail("EVENT_SITE_INVALID_SPEC", "页面规格必须是一个对象。");
  for (const key of Object.keys(input)) {
    if (!SPEC_FIELDS.has(key)) fail("EVENT_SITE_UNKNOWN_SPEC_FIELD", "页面规格不接受字段「" + key + "」；布局由引擎派生，不能写进规格。");
  }
  if (input.version === undefined || input.version === null) {
    if (mode === "strict") fail("EVENT_SITE_UNSUPPORTED_VERSION", "页面规格缺少 version，当前只支持 " + String(EVENT_SITE_SPEC_VERSION) + "。");
  } else if (input.version !== EVENT_SITE_SPEC_VERSION) {
    fail("EVENT_SITE_UNSUPPORTED_VERSION", "页面规格版本「" + String(input.version) + "」不受支持，当前只支持 " + String(EVENT_SITE_SPEC_VERSION) + "。");
  }
  const blocks = readBlocks(input.blocks, mode);
  crossBlockRules(blocks);
  let skin: EventSiteSkin | undefined;
  if (input.skin !== undefined && input.skin !== null) {
    if (input.skin !== "classic" && input.skin !== "dark" && input.skin !== "paper" && input.skin !== "neon") {
      fail("EVENT_SITE_INVALID_SKIN", "视觉皮肤只能是平台预置的几套（classic / dark / paper / neon）。", 422);
    }
    skin = input.skin;
  }
  const spec: EventSitePageSpec = skin === undefined ? { version: 1, blocks: blocks } : { version: 1, blocks: blocks, skin };
  if (jsonByteLength(spec) > EVENT_SITE_MAX_SPEC_BYTES) {
    fail("EVENT_SITE_SPEC_TOO_LARGE", "页面规格超过 " + String(EVENT_SITE_MAX_SPEC_BYTES / 1024) + "KB 上限，请减少区块或精简文案。", 413);
  }
  return spec;
}

/** 严格形态：区块必须带 id / kind / variant / priority / collapse，缺一即拒绝。 */
export function parseSpec(input: unknown): EventSitePageSpec {
  return read(input, "strict");
}

/** 宽容形态：缺省字段按注册表补默认值（id 由序号派生），其余校验与 parseSpec 一致。 */
export function normalizeSpec(input: unknown): EventSitePageSpec {
  return read(input, "normalize");
}

/** 序列化（压成可入库/可比较的字符串）。超限抛 EVENT_SITE_SPEC_TOO_LARGE。 */
export function serializeSpec(spec: EventSitePageSpec): string {
  return JSON.stringify(normalizeSpec(spec));
}

/** 规格序列化后的字节数；超限直接抛错，与入库前检查同一条规则。 */
export function specByteLength(spec: EventSitePageSpec): number {
  return jsonByteLength(normalizeSpec(spec));
}
