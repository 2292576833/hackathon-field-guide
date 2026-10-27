"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, message as errorMessage } from "./client-api.ts";
import { EventSiteRenderer } from "./event-site-renderer.tsx";
import {
  EVENT_SITE_BINDING_FIELD_SOURCE, EVENT_SITE_BLOCK_KINDS, EVENT_SITE_DEFAULT_PRIORITY,
  blockDeclaration, defaultPageSpec, deleteAdvice, isActionBlock, isAiContainerBlock,
} from "../modules/event-site/blocks.ts";
import { deriveLayout, reviewSpec } from "../modules/event-site/policy.ts";
import { EVENT_SITE_STARTER_TEMPLATES } from "../modules/event-site/templates.ts";
import { EVENT_SITE_DESIGN_PRESETS, designPreset } from "../modules/event-site/designs.ts";
import type {
  EventSiteBindingField, EventSiteBlockKind, EventSiteBlockNode, EventSiteContentBlockKind, EventSitePageSpec, EventSitePriority,
} from "../modules/event-site/model.ts";
import styles from "./event-site-editor.module.css";

interface Finding { readonly level: string; readonly code: string; readonly message: string; readonly fixHint: string | null; readonly blockId: string | null }
interface SuggestionPatch { readonly kind: "replace_block" | "add_block" | "remove_block"; readonly blockId?: string; readonly block?: EventSiteBlockNode }
interface Suggestion { readonly id: string; readonly title: string; readonly rationale: string; readonly patch?: SuggestionPatch }
interface GenerationResult { readonly spec: EventSitePageSpec; readonly usedFallback: boolean; readonly failure: { readonly code: string; readonly message: string } | null; readonly findings: readonly Finding[] }
interface SuggestionResult { readonly suggestions: readonly Suggestion[]; readonly dropped: number }
interface Pin {
  id: string; placementKind: "after" | "before" | "inside"; blockId: string;
  wantKind: "insert" | "replace" | "reword"; blockKind: string; targetBlockId: string;
  instruction: string; mobileOnly: boolean;
  /** list = 右侧面板新增；canvas = 空白画布上扔的；preview = 预览上打点。 */
  surface: "list" | "canvas" | "preview" | "area";
  x: number; y: number; open: boolean;
  /** 圈选命中多块时，一条气泡会展开成多条批注（每块一条）。 */
  blockIds?: readonly string[];
}
interface AnnotationResponse { readonly appliedSpec: EventSitePageSpec; readonly results: readonly { readonly annotationId: string; readonly status: string; readonly reason?: string }[]; readonly dropped: number }
interface RefineResponse { readonly spec: EventSitePageSpec; readonly changedBlockIds: readonly string[]; readonly dropped: number }
interface Capability { readonly model: boolean; readonly stream: boolean; readonly reason: string | null }
interface UploadHint { readonly aspect: "16:9" | "4:3" | "1:1" | "3:4"; readonly blocks: readonly string[]; readonly note: string }
interface RevisionSummary { readonly revision: number; readonly createdBy: string; readonly createdAt: string }
interface RevisionList { readonly revisions: readonly RevisionSummary[]; readonly truncated: boolean }
interface TemplateView { readonly id: string; readonly name: string; readonly revision: number; readonly createdAt: string; readonly updatedAt: string }
const EMPTY_FACTS = {
  registrationCloses: null, submissionCloses: null, startsAt: null, endsAt: null,
  scheduleNodes: [] as readonly never[], faqEntries: [] as readonly never[],
};

let pinCounter = 0;
function nextPinId(): string { pinCounter += 1; return `pin-${Date.now().toString(36)}-${pinCounter}`; }
interface PageView {
  readonly exists: boolean; readonly eventId: string; readonly organizationId: string;
  readonly spec: EventSitePageSpec | null; readonly published: EventSitePageSpec | null;
  readonly revision: number; readonly status: "draft" | "published" | "suspended";
  readonly shortCode: string | null; readonly publishedRevision: number | null; readonly publishedAt: string | null;
  readonly suspension: { readonly kind: "organizer" | "platform"; readonly reason: string | null; readonly at: string; readonly by: string } | null;
  readonly suggestedSpec: EventSitePageSpec | null; readonly findings: readonly Finding[];
  readonly auditRecorded: boolean; readonly auditNotice: string | null;
}

const statusLabels: Record<PageView["status"], string> = { draft: "草稿", published: "已发布", suspended: "已停用" };
const statusClass: Record<PageView["status"], string> = { draft: styles.draft, published: styles.published, suspended: styles.suspended };
let counter = 0;
function nextId(): string { counter += 1; return `blk-${Date.now().toString(36)}-${counter}`; }

function newBlock(kind: EventSiteBlockKind): EventSiteBlockNode {
  const declaration = blockDeclaration(kind);
  const base = { kind, id: nextId(), variant: declaration.defaultVariant, priority: EVENT_SITE_DEFAULT_PRIORITY, collapse: false };
  if (declaration.actionTarget !== null) return { ...base, action: declaration.actionTarget } as EventSiteBlockNode;
  if (declaration.category === "container") {
    return { ...base, manages: [], duty: null, mode: "edit", fullPage: false } as EventSiteBlockNode;
  }
  const field = declaration.requiresBinding ? declaration.allowedBindingFields[0] ?? null : null;
  return {
    ...base, heading: null, text: null, items: [], image: null,
    binding: field === null ? null : { source: EVENT_SITE_BINDING_FIELD_SOURCE[field], field },
  } as EventSiteBlockNode;
}

/**
 * 规划35 P1c：专属页编辑台。
 *
 * 快捷优先：组件箱一键加入、列表上下移动、就地改文案、规则提醒**本地即时**（reviewSpec 是纯函数，不调模型）。
 * 保存是 CAS（带 revision），发布只从草稿打快照。
 */
export function EventSiteEditor({ eventId }: { readonly eventId: string }) {
  const base = `/organizer/events/${encodeURIComponent(eventId)}/page`;
  const [view, setView] = useState<PageView | null>(null);
  const [spec, setSpec] = useState<EventSitePageSpec | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [reason, setReason] = useState("临时下线");
  const [intent, setIntent] = useState({ title: "", kind: "校园赛", audience: "", emphasis: "", tone: "", notes: "" });
  const [aiBusy, setAiBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionResult | null>(null);
  const [pins, setPins] = useState<readonly Pin[]>([]);
  const [streamedBlocks, setStreamedBlocks] = useState(0);
  const [streamedDrafts, setStreamedDrafts] = useState<readonly { kind: string }[]>([]);
  const [previewMode, setPreviewMode] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [surfaceMode, setSurfaceMode] = useState<"editor" | "canvas">("editor");
  // 规划35 §19.1 / §19.5：随时撤销 + 自动保存（不再要求「点保存」）。
  const specRef = useRef<EventSitePageSpec | null>(null);
  const undoStack = useRef<EventSitePageSpec[]>([]);
  const redoStack = useRef<EventSitePageSpec[]>([]);
  const lastSavedRef = useRef<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [droppedDesign, setDroppedDesign] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } | null>(null);
  const [deleted, setDeleted] = useState<{ readonly impact: string; readonly stillReachable: string; readonly undoHint: string } | null>(null);
  const [cancelController, setCancelController] = useState<AbortController | null>(null);
  const [refineText, setRefineText] = useState("");
  const [capability, setCapability] = useState<Capability | null>(null);
  const [context, setContext] = useState<{ eventTitle: string } | null>(null);
  const [facts, setFacts] = useState<{
    readonly registrationCloses: string | null; readonly submissionCloses: string | null;
    readonly startsAt: string | null; readonly endsAt: string | null;
    readonly scheduleNodes: readonly { readonly id: string; readonly title: string; readonly at: string | null; readonly kind: string }[];
    readonly faqEntries: readonly { readonly id: string; readonly question: string; readonly answer: string }[];
  } | null>(null);
  const [realtime, setRealtime] = useState(false);
  const [history, setHistory] = useState<RevisionList | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [pendingAsset, setPendingAsset] = useState<string | null>(null);
  const [pendingHint, setPendingHint] = useState<UploadHint | null>(null);
  const [templates, setTemplates] = useState<readonly TemplateView[] | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateError, setTemplateError] = useState("");

  const load = useCallback(async () => {
    setFailure("");
    try {
      const loaded = await api<PageView>(base);
      setView(loaded);
      const initial = loaded.spec ?? loaded.suggestedSpec ?? defaultPageSpec();
      specRef.current = initial;
      setSpec(initial);
      lastSavedRef.current = JSON.stringify(initial);
      undoStack.current = [];
      redoStack.current = [];
      setSaveState("idle");
      setConflict(false);
      setSelectedId(null);
    } catch (error) { setFailure(errorMessage(error)); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  /** 任何改动都先记进撤销栈；AI 结果同样可撤销。 */
  function replaceSpec(value: EventSitePageSpec) {
    const current = specRef.current;
    if (current !== null && JSON.stringify(current) !== JSON.stringify(value)) {
      undoStack.current = [...undoStack.current.slice(-49), current];
      redoStack.current = [];
    }
    specRef.current = value;
    setSpec(value);
  }
  function applySpec(updater: (current: EventSitePageSpec) => EventSitePageSpec) {
    const current = specRef.current;
    if (current === null) return;
    replaceSpec(updater(current));
  }
  function undo() {
    const previous = undoStack.current.pop();
    if (previous === undefined || specRef.current === null) return;
    redoStack.current = [...redoStack.current, specRef.current];
    specRef.current = previous;
    setSpec(previous);
  }
  function redo() {
    const next = redoStack.current.pop();
    if (next === undefined || specRef.current === null) return;
    undoStack.current = [...undoStack.current, specRef.current];
    specRef.current = next;
    setSpec(next);
  }

  /** 规划35 §19.5：输入停止即存，顶部只显示「已保存 · 12:04」。 */
  const saveNow = useCallback(async () => {
    const current = specRef.current;
    if (current === null || view === null || conflict) return;
    const serialized = JSON.stringify(current);
    if (serialized === lastSavedRef.current) return;
    setSaveState("saving");
    try {
      const result = await api<{ revision: number }>(base, { method: "PUT", body: { spec: current, expectedRevision: view.revision } });
      lastSavedRef.current = serialized;
      setView(currentView => currentView === null ? currentView : { ...currentView, revision: result.revision });
      setSaveState("saved");
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
    } catch (error) {
      setSaveState("error");
      if ((error as { status?: number }).status === 409) {
        setConflict(true);
        setNotice("这一页在别处被改过：先点「重新读取」再改，避免覆盖别人的修改。");
      }
    }
  }, [base, view, conflict]);

  useEffect(() => {
    if (spec === null || view === null || aiBusy || conflict) return;
    if (view.status === "suspended") return;
    if (JSON.stringify(spec) === lastSavedRef.current) return;
    const timer = setTimeout(() => { void saveNow(); }, 800);
    return () => clearTimeout(timer);
  }, [spec, view, aiBusy, conflict, saveNow]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "s") { event.preventDefault(); void saveNow(); return; }
      if (meta && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (meta && event.key === "Enter") { event.preventDefault(); void publish(); return; }
      if (typing) return;
      if (event.key === "Escape") { setSelectedId(null); return; }
      if (event.key === "ArrowUp" && selectedId !== null) { event.preventDefault(); moveBlock(selectedId, -1); return; }
      if (event.key === "ArrowDown" && selectedId !== null) { event.preventDefault(); moveBlock(selectedId, 1); return; }
      if (event.key === "/") {
        event.preventDefault();
        const palette = document.getElementById("event-site-palette");
        palette?.scrollIntoView({ block: "center" });
        palette?.querySelector("button")?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    // 开关是**本机偏好**（默认关）；真正的可用性由服务端能力报告决定。
    try { setRealtime(window.localStorage.getItem("event-site-realtime") === "1"); } catch { setRealtime(false); }
    void api<Capability>(`${base}/ai-capability`).then(setCapability).catch(() => setCapability(null));
    void api<{ eventTitle: string }>(`${base}/context`).then(setContext).catch(() => setContext(null));
    void api<typeof facts>(`${base}/facts`).then(setFacts).catch(() => setFacts(null));
  }, [base]);

  const findings = useMemo(() => (spec === null ? [] : reviewSpec(spec)), [spec]);
  /** 规划35 §19.5：发布前显示「与线上差异 N 处」。 */
  const diffCount = useMemo(() => {
    if (spec === null) return 0;
    const published = view?.published ?? null;
    if (published === null) return spec.blocks.length;
    const before = new Map(published.blocks.map(block => [block.id, JSON.stringify(block)]));
    let changed = 0;
    for (const block of spec.blocks) {
      const previous = before.get(block.id);
      if (previous === undefined || previous !== JSON.stringify(block)) changed += 1;
      before.delete(block.id);
    }
    return changed + before.size;
  }, [spec, view]);
  const selected = spec === null ? undefined : spec.blocks.find(block => block.id === selectedId);
  const contentBlocks = spec === null ? [] : spec.blocks.filter(block => !isActionBlock(block) && !isAiContainerBlock(block));

  function patchBlock(id: string, changes: Record<string, unknown>) {
    applySpec(current => ({ ...current, blocks: current.blocks.map(block => block.id === id ? { ...block, ...changes } as EventSiteBlockNode : block) }));
  }
  function removeBlock(id: string) {
    const block = spec?.blocks.find(item => item.id === id);
    if (!block) return;
    // 删除只给建议，不阻止（规划 35 §5.2：影响 / 仍可到达 / 一键恢复）。
    setDeleted(deleteAdvice(block.kind));
    applySpec(current => ({ ...current, blocks: current.blocks.filter(item => item.id !== id) }));
    if (selectedId === id) setSelectedId(null);
  }
  /** 把一个设计灵感套到当前页：先换皮肤，再问要不要让 AI 按这个风格改写。 */
  function applyDesign(id: string) {
    const preset = designPreset(id);
    if (preset === null) return;
    applySpec(current => ({ ...current, skin: preset.skin }));
    setDroppedDesign(preset.id);
    setNotice(`已套用「${preset.name}」的视觉（${preset.mood}）。要不要让 AI 按这个风格把文案也改写一遍？`);
  }
  function moveBlockTo(fromId: string, toId: string) {
    applySpec(current => {
      const from = current.blocks.findIndex(block => block.id === fromId);
      const to = current.blocks.findIndex(block => block.id === toId);
      if (from < 0 || to < 0 || from === to) return current;
      const blocks = [...current.blocks];
      const [moved] = blocks.splice(from, 1);
      blocks.splice(to, 0, moved!);
      return { ...current, blocks };
    });
  }
  function moveBlock(id: string, delta: number) {
    applySpec(current => {
      const index = current.blocks.findIndex(block => block.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.blocks.length) return current;
      const blocks = [...current.blocks];
      const [moved] = blocks.splice(index, 1);
      blocks.splice(target, 0, moved!);
      return { ...current, blocks };
    });
  }

  async function run(work: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setFailure(""); setNotice("");
    try { setNotice(await work()); await load(); }
    catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  }
  const publish = () => run(async () => {
    if (view === null) return "";
    const result = await api<{ publishedRevision: number }>(`${base}/publish`, { method: "POST", body: { expectedRevision: view.revision } });
    return `已发布第 ${result.publishedRevision} 版。`;
  });
  const rotate = () => run(async () => {
    if (view === null) return "";
    await api(`${base}/short-code/reset`, { method: "POST", body: { expectedRevision: view.revision } });
    return "短码已重置，旧链接立即失效。";
  });
  const suspend = () => run(async () => {
    if (view === null) return "";
    await api(`${base}/suspend`, { method: "POST", body: { expectedRevision: view.revision, kind: "organizer", reason } });
    return "已停用。选手访问会看到 404，但平台赛事页与报名不受影响。";
  });
  const resume = () => run(async () => {
    if (view === null) return "";
    await api(`${base}/resume`, { method: "POST", body: { expectedRevision: view.revision } });
    return "已恢复。";
  });

  async function loadHistory() {
    setHistoryError("");
    try { setHistory(await api<RevisionList>(`${base}/revisions`)); }
    catch (error) { setHistory(null); setHistoryError(errorMessage(error)); }
  }
  async function restoreRevision(revision: number) {
    if (view === null || aiBusy) return;
    setAiBusy(true); setFailure(""); setNotice("");
    try {
      await api(`${base}/revisions/${revision}/restore`, { method: "POST", body: { expectedRevision: view.revision } });
      setNotice(`已回退到第 ${revision} 版：这会产生一个新草稿版本，线上内容不受影响。`);
      await load(); await loadHistory();
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  async function loadTemplates(organizationId: string) {
    setTemplateError("");
    try {
      const result = await api<{ items: readonly TemplateView[] }>(`/organizer/page-templates?organizationId=${encodeURIComponent(organizationId)}`);
      setTemplates(result.items);
    } catch (error) { setTemplates(null); setTemplateError(errorMessage(error)); }
  }
  async function saveTemplate(organizationId: string) {
    if (spec === null || templateName.trim() === "") { setTemplateError("先给模板起个名字。"); return; }
    setAiBusy(true); setTemplateError("");
    try {
      // 机构从查询串来（与模块 handler 一致），正文只带名字与规格。
      await api(`/organizer/page-templates?organizationId=${encodeURIComponent(organizationId)}`, { method: "POST", body: {
        name: templateName.trim(), spec,
      } });
      setNotice("已存为机构模板，下次办活动可以直接套用。");
      setTemplateName("");
      await loadTemplates(organizationId);
    } catch (error) { setTemplateError(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  async function applyTemplate(templateId: string) {
    if (view === null) return;
    setAiBusy(true); setTemplateError("");
    try {
      await api(`${base}/apply-template`, { method: "POST", body: { templateId, expectedRevision: view.revision } });
      setNotice("已套用模板（复制一份快照，不和模板联动）。");
      await load();
    } catch (error) { setTemplateError(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  async function deleteTemplate(organizationId: string, templateId: string) {
    setAiBusy(true); setTemplateError("");
    try {
      await api(`/organizer/page-templates/${encodeURIComponent(templateId)}?organizationId=${encodeURIComponent(organizationId)}`, { method: "DELETE" });
      await loadTemplates(organizationId);
    } catch (error) { setTemplateError(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  async function uploadImage(file: File): Promise<void> {
    if (aiBusy) return;
    setAiBusy(true); setFailure(""); setNotice("");
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      const result = await api<{ assetId: string; suggestion: UploadHint | null }>(`${base}/assets`, {
        method: "POST", body: { mimeType: file.type, base64 },
      });
      setPendingAsset(result.assetId);
      setPendingHint(result.suggestion);
      setNotice(result.suggestion === null
        ? "图片已存档（读不到宽高，所以没有放置建议）。选中图片块后点“用这张图”。"
        : `图片已存档；按宽高比建议 ${result.suggestion.aspect}（${result.suggestion.blocks.join(" / ")}）。这只是按尺寸给的建议，不看图片内容。`);
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  /** 在画布或预览的 (x,y) 开一个气泡；blockId 是它要改/插在哪一块。 */
  function openBubble(surface: "canvas" | "preview" | "area", x: number, y: number, blockId: string, blockIds?: readonly string[]) {
    const pin: Pin = {
      id: nextPinId(), placementKind: "after", blockId,
      wantKind: surface === "canvas" ? "insert" : "reword",
      ...(blockIds === undefined ? {} : { blockIds }),
      blockKind: "highlights", targetBlockId: blockId, instruction: "", mobileOnly: false,
      surface, x, y, open: true,
    };
    setPins(current => [...current, pin]);
  }
  function patchPin(id: string, changes: Partial<Pin>) {
    setPins(current => current.map(item => item.id === id ? { ...item, ...changes } : item));
  }
  function addPin() {
    const anchor = selectedId ?? spec?.blocks.find(block => !isActionBlock(block) && !isAiContainerBlock(block))?.id ?? "";
    setPins(current => [...current, {
      id: nextPinId(), placementKind: "after", blockId: anchor, wantKind: "reword",
      blockKind: "highlights", targetBlockId: anchor, instruction: "", mobileOnly: false,
      surface: "list", x: 0, y: 0, open: true,
    }]);
  }
  async function applyPins() {
    if (aiBusy) return;
    const anchorFallback = spec?.blocks.length ? spec.blocks[spec.blocks.length - 1]!.id : "";
    const usable = pins.filter(pin => pin.instruction.trim() !== "");
    if (usable.some(pin => pin.blockId === "" && anchorFallback === "")) {
      setNotice("页面上还没有任何区块：先在组件箱加一块，气泡才有地方可插。");
      return;
    }
    if (usable.length === 0) { setNotice("先写一条批注（并且选中一个区块）再应用。"); return; }
    setAiBusy(true); setFailure(""); setNotice("");
    try {
      const expanded = usable.flatMap(pin => {
      const targets = pin.blockIds !== undefined && pin.blockIds.length > 0 ? pin.blockIds : [pin.blockId || anchorFallback];
      return targets.map((blockId, index) => ({ pin, blockId, index, total: targets.length }));
    });
    const result = await api<AnnotationResponse>(`${base}/annotations`, { method: "POST", body: { annotations: expanded.map(({ pin, blockId, index }) => ({
        id: pin.blockIds === undefined || pin.blockIds.length <= 1 ? pin.id : `${pin.id.slice(0, 56)}-${index}`,
        placement: { kind: pin.placementKind, blockId },
        want: pin.wantKind === "insert" ? { kind: "insert", blockKind: pin.blockKind }
          : pin.wantKind === "replace" ? { kind: "replace", targetBlockId: pin.targetBlockId || pin.blockId }
          : { kind: "reword" },
        instruction: pin.instruction.trim(), mobileOnly: pin.mobileOnly,
      })) } });
      replaceSpec(result.appliedSpec);
      const applied = result.results.filter(item => item.status === "applied").length;
      setNotice(`已应用 ${applied} 条批注${result.dropped > 0 ? `，丢弃 ${result.dropped} 条不合规` : ""}。记得点“保存”。`);
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  async function refine(containerId: string, instruction: string) {
    if (aiBusy || instruction.trim() === "") return;
    setAiBusy(true); setFailure(""); setNotice("");
    try {
      const result = await api<RefineResponse>(`${base}/ai-blocks/${encodeURIComponent(containerId)}/refine`, { method: "POST", body: { instruction: instruction.trim() } });
      replaceSpec(result.spec);
      setNotice(`AI 改了 ${result.changedBlockIds.length} 个区块${result.dropped > 0 ? `，丢弃 ${result.dropped} 条越界或不合规` : ""}。记得点“保存”。`);
      setRefineText("");
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  function toggleRealtime(next: boolean) {
    setRealtime(next);
    try { window.localStorage.setItem("event-site-realtime", next ? "1" : "0"); } catch { /* 隐私模式下写不进去就算了 */ }
    if (next && capability !== null && !capability.stream) {
      setNotice("当前提供方不支持流式输出，实时生成已降级为一次性生成（内容不受影响，只是没有逐块出现）。");
    }
  }
  /**
   * 规划35 §6.5：有流式能力时逐块出现（真实增量渲染）。
   * 拿到 409 说明提供方不支持，返回 false 让调用方回落一次性生成——不假装在流式。
   */
  async function generateStreaming(intentBody: unknown): Promise<boolean> {
    const controller = new AbortController();
    setCancelController(controller);
    const response = await fetch(`/api/v1${base}/generate/stream`, {
      method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: intentBody }),
    });
    if (response.status === 409 || response.body === null) return false;
    if (!response.ok) {
      const envelope = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(envelope?.error?.message ?? "流式生成失败");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", count = 0, finalSpec: EventSitePageSpec | null = null;
    setStreamedBlocks(0);
    setStreamedDrafts([]);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const event = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const name = /^event: (.+)$/m.exec(event)?.[1];
        const raw = /^data: (.+)$/m.exec(event)?.[1];
        if (name !== undefined && raw !== undefined) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (name === "block") {
            count += 1;
            setStreamedBlocks(count);
            setStreamedDrafts(current => [...current, parsed as { kind: string }]);
          }
          else if (name === "done") finalSpec = parsed.spec as EventSitePageSpec;
          else if (name === "error") throw new Error(String(parsed.message ?? "流式生成中断"));
        }
        index = buffer.indexOf("\n\n");
      }
    }
    if (finalSpec === null) throw new Error("流式生成没有给出完整规格");
    replaceSpec(finalSpec);
    setCancelController(null);
    return true;
  }
  async function generate(notesOverride?: string) {
    if (aiBusy) return;
    setAiBusy(true); setFailure(""); setNotice("");
    try {
      if (context === null) { setFailure("还没读到赛事名称，稍等一下再生成。"); return; }
      const intentBody = {
        eventTitle: context.eventTitle,
        kind: intent.kind, audience: intent.audience.trim(), tone: intent.tone.trim(),
        emphasis: intent.emphasis.split(/[,，、]/).map(item => item.trim()).filter(item => item !== ""),
        notes: (notesOverride ?? intent.notes).trim(),
      };
      if (realtime && capability?.stream === true) {
        const streamed = await generateStreaming(intentBody);
        if (streamed) { setNotice("流式生成完成，已逐块出现；检查后点“保存”。"); return; }
        setNotice("提供方这次不能流式，已回落为一次性生成。");
      }
      const result = await api<GenerationResult>(`${base}/generate`, { method: "POST", body: { intent: intentBody } });
      replaceSpec(result.spec);
      setNotice(result.usedFallback
        ? `模型输出没有通过校验（${result.failure?.code ?? "未知原因"}），已用默认模块集；请手动调整后保存。`
        : "已生成草案：手机端已按优先级排成单列（切 375 可看）。生成不会自动发布。");
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  async function suggest() {
    if (aiBusy || spec === null) return;
    setAiBusy(true); setFailure(""); setNotice("");
    try {
      const result = await api<SuggestionResult>(`${base}/suggestions`, { method: "POST", body: { spec } });
      setSuggestions(result);
      if (result.suggestions.length === 0) setNotice("这次没有可用的建议。");
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  function applySuggestion(suggestion: Suggestion) {
    const patch = suggestion.patch;
    if (patch === undefined) { setNotice("这条只是说明，没有可自动应用的结构改动。"); return; }
    applySpec(current => {
      if (patch.kind === "add_block" && patch.block !== undefined) return { ...current, blocks: [...current.blocks, patch.block] };
      if (patch.kind === "remove_block") return { ...current, blocks: current.blocks.filter(block => block.id !== patch.blockId) };
      if (patch.kind === "replace_block" && patch.block !== undefined) {
        let replaced = false;
        const blocks = current.blocks.map(block => {
          if (block.id !== (patch.blockId ?? patch.block!.id)) return block;
          replaced = true; return patch.block!;
        });
        return replaced ? { ...current, blocks } : { ...current, blocks: [...blocks, patch.block] };
      }
      return current;
    });
    setNotice("已把这 1 条改到草稿上；记得点“保存”。");
  }

  if (failure && view === null) return <p role="alert">专属页没有读到：{failure}</p>;
  if (view === null || spec === null) return <p>正在读取专属页…</p>;

  const shortCode = view.shortCode;
  const publicHref = shortCode === null ? null : `/s/${shortCode}`;
  const layout = deriveLayout(spec);

  return (
    <div className={styles.shellRoot}>
      {/* 顶栏：状态 / 保存态 / 撤销 / 发布 / 更多 */}
      <div className={styles.topbar}>
        <span className={`${styles.badge} ${statusClass[view.status]}`}>{statusLabels[view.status]}</span>
        <span className={styles.rowMeta}>版本 {view.revision}{view.publishedRevision === null ? "" : ` · 线上 v${view.publishedRevision}`}</span>
        {shortCode === null ? null : <span className={styles.code}>{publicHref}</span>}
        {shortCode === null ? null : <CopyButton text={publicHref ?? ""} />}
        <span className={styles.rowMeta} role="status">
          {conflict ? "有冲突" : saveState === "saving" ? "保存中…" : saveState === "saved" ? `已保存${savedAt === null ? "" : " · " + savedAt}` : saveState === "error" ? "保存失败" : "自动保存已开"}
        </span>
        <button type="button" className={styles.iconButton} aria-label="撤销" title="撤销（Ctrl/⌘+Z）" onClick={undo}>↶</button>
        <button type="button" className={styles.iconButton} aria-label="重做" title="重做（Shift+Ctrl/⌘+Z）" onClick={redo}>↷</button>
        {conflict ? <button type="button" className={styles.iconButton} onClick={() => void load()}>重新读取</button> : null}
        <span className={styles.topbarSpacer}/>
        <button type="button" className={styles.iconButton} disabled={busy} onClick={() => void publish()}>
          发布{view.published === null ? "" : `（差异 ${diffCount} 处）`}
        </button>
        <details className={styles.more}>
          <summary className={styles.iconButton} aria-label="更多">⋯</summary>
          <div className={styles.morePanel}>
            <label className={styles.field}><span>停用理由</span>
              <input value={reason} maxLength={200} onChange={event => setReason(event.target.value)} /></label>
            <button type="button" className={styles.iconButton} disabled={busy} onClick={() => void rotate()}>重置短码</button>
            {view.status === "suspended"
              ? <button type="button" className={styles.iconButton} disabled={busy} onClick={() => void resume()}>恢复</button>
              : <button type="button" className={styles.iconButton} disabled={busy} onClick={() => void suspend()}>停用</button>}
          </div>
        </details>
      </div>

      {view.suspension === null ? null : (
        <p className={styles.rowMeta}>停用来源：{view.suspension.kind === "platform" ? "平台管理员" : "主办方"}{view.suspension.reason === null ? "" : ` · 理由：${view.suspension.reason}`}{view.suspension.kind === "platform" ? "（主办方不能自行恢复）" : ""}</p>) }
      {view.auditRecorded ? null : <p className={styles.rowMeta}>{view.auditNotice}</p>}
      {notice && <p role="status">{notice}</p>}
      {failure && <p role="alert">{failure}</p>}
      {deleted === null ? null : (
        <div className={styles.pane} role="status">
          <p className={styles.rowMeta}><strong>已删除</strong> · {deleted.impact}</p>
          <p className={styles.rowMeta}>{deleted.stillReachable}</p>
          <div className={styles.bar}>
            <button type="button" className={styles.iconButton} onClick={() => { undo(); setDeleted(null); }}>{deleted.undoHint}</button>
            <button type="button" className={styles.iconButton} onClick={() => setDeleted(null)}>知道了</button>
          </div>
        </div>) }

      <div className={styles.workspace}>
        {/* 左栏：组件箱 + 层级 */}
        <aside className={styles.leftCol}>
          <section className={styles.pane} aria-label="组件箱" id="event-site-palette">
            <p className={styles.sectionTitle}>组件箱</p>
            <button type="button" className={styles.paletteButton} disabled={busy}
              onClick={() => { applySpec(() => defaultPageSpec()); setNotice("已恢复默认模块集，可撤销。"); }}>
              一键恢复默认模块集<small>赛事信息、报名、提交、赛程、公告、FAQ、结果、页脚</small>
            </button>
            <div className={styles.palette}>
              {EVENT_SITE_BLOCK_KINDS.map(kind => {
                const declaration = blockDeclaration(kind);
                return (
                  <button type="button" key={kind} className={styles.paletteButton} disabled={busy} title={declaration.hint}
                    onClick={() => {
                      const block = newBlock(kind);
                      applySpec(current => {
                        const at = selectedId === null ? -1 : current.blocks.findIndex(item => item.id === selectedId);
                        const blocks = [...current.blocks];
                        blocks.splice(at < 0 ? blocks.length : at + 1, 0, block);
                        return { ...current, blocks };
                      });
                      setSelectedId(block.id);
                    }}>
                    {declaration.label}<small>{declaration.hint}</small>
                  </button>);
              })}
            </div>
          </section>

          <section className={styles.pane} aria-label="设计灵感">
            <p className={styles.sectionTitle}>设计灵感（可拖进画布）</p>
            <p className={styles.rowMeta}>拖到画布上（或点「套用」）先换视觉；再决定要不要让 AI 按这个风格改写文案。</p>
            <ul className={styles.layers}>
              {EVENT_SITE_DESIGN_PRESETS.map(preset => (
                <li key={preset.id} className={styles.designCard} draggable
                  onDragStart={event => { event.dataTransfer.setData("application/x-event-site-design", preset.id); event.dataTransfer.effectAllowed = "copy"; }}>
                  <span className={styles.designSwatches}>
                    {preset.swatches.map(color => <i key={color} style={{ background: color }} />)}
                  </span>
                  <span className={styles.layerLabel} style={{ whiteSpace: "normal" }}>
                    <strong>{preset.name}</strong>
                    <span className={styles.rowMeta}> · {preset.mood}</span>
                  </span>
                  <button type="button" className={styles.chipButton} disabled={busy} onClick={() => applyDesign(preset.id)}>套用</button>
                </li>))}
            </ul>
          </section>

          <section className={styles.pane} aria-label="模板库">
            <p className={styles.sectionTitle}>起步模板</p>
            <p className={styles.rowMeta}>下面每张都是**真实渲染**（含它自带的配色与排版）。套用会替换当前草稿，可撤销、自动保存。</p>
            <div className={styles.templateGrid}>
              {EVENT_SITE_STARTER_TEMPLATES.map(template => {
                const templateSpec = template.build();
                return (
                  <div key={template.id} className={styles.templateCard}>
                    <div className={styles.templatePreview}>
                      <div className={styles.templateScaler}>
                        <EventSiteRenderer spec={templateSpec} layout={deriveLayout(templateSpec)}
                          facts={EMPTY_FACTS} actionHref={() => "#"}
                          eventTitle={context?.eventTitle ?? "示例赛事"} organizerName="" canonicalHref="#" publishedAt={null} />
                      </div>
                    </div>
                    <strong className={styles.templateName}>{template.name}</strong>
                    <span className={styles.rowMeta}>{template.tagline}</span>
                    <span className={styles.rowMeta}>皮肤 {template.skin} · 适合 {template.bestFor}</span>
                    <button type="button" className={styles.chipButton} disabled={busy}
                      onClick={() => { replaceSpec(template.build()); setNotice(`已套用「${template.name}」，改完会自动保存；不满意可撤销。`); }}>用这个</button>
                  </div>);
              })}
            </div>
          </section>
          <section className={styles.pane} aria-label="层级">
            <p className={styles.sectionTitle}>层级（{spec.blocks.length}）</p>
            {spec.blocks.length === 0 ? <p className={styles.rowMeta}>还没有区块。空页也合法。</p> : (
              <ul className={styles.layers}>
                {spec.blocks.map(block => (
                  <li key={block.id} draggable
                    onDragStart={() => setDragId(block.id)}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={event => event.preventDefault()}
                    onDrop={event => { event.preventDefault(); if (dragId !== null && dragId !== block.id) moveBlockTo(dragId, block.id); setDragId(null); }}
                    className={`${styles.layerRow} ${selectedId === block.id ? styles.layerRowActive : ""} ${dragId === block.id ? styles.layerRowDragging : ""}`}>
                    <span className={styles.layerGrip} aria-hidden="true">⋮⋮</span>
                    <button type="button" className={styles.layerLabel}
                      onClick={() => {
                        setSelectedId(block.id);
                        document.querySelector(`[data-block-id="${block.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
                      }}>
                      {blockDeclaration(block.kind).label}
                    </button>
                    <span className={styles.layerTools}>
                      <button type="button" aria-label="上移" onClick={() => moveBlock(block.id, -1)}>↑</button>
                      <button type="button" aria-label="下移" onClick={() => moveBlock(block.id, 1)}>↓</button>
                      <button type="button" aria-label="删除" onClick={() => removeBlock(block.id)}>✕</button>
                    </span>
                  </li>))}
              </ul>) }
          </section>
        </aside>

        {/* 中间：画布 */}
        <main className={styles.centerCol}>
          <div className={styles.canvasToolbar}>
            {(["desktop", "tablet", "mobile"] as const).map(mode => (
              <button type="button" key={mode} className={styles.iconButton} aria-pressed={previewMode === mode}
                onClick={() => setPreviewMode(mode)}>{mode === "desktop" ? "1440" : mode === "tablet" ? "768" : "375"}</button>))}
            <span className={styles.canvasDivider}/>
            <button type="button" className={styles.iconButton} aria-pressed={surfaceMode === "canvas"}
              onClick={() => setSurfaceMode(surfaceMode === "canvas" ? "editor" : "canvas")}>想法画布</button>
            <button type="button" className={styles.iconButton} aria-label="快捷键" title="快捷键" onClick={() => setShortcutsOpen(true)}>?</button>
            <span className={styles.topbarSpacer}/>
            <span className={styles.rowMeta}>右键画布可加气泡批注</span>
          </div>

          {surfaceMode === "canvas" ? (
            <div>
              <div className={styles.bar}>
                <button type="button" className={styles.iconButton} aria-pressed={placing} onClick={() => setPlacing(value => !value)}>
                  {placing ? "点一下空白处…" : "＋ 想法"}
                </button>
                <button type="button" className={styles.iconButton} disabled={aiBusy || pins.length === 0} onClick={() => void applyPins()}>
                  {aiBusy ? "处理中…" : `应用批注（${pins.length}）`}
                </button>
                <span className={styles.rowMeta}>气泡只描述想法，不会自己改页面。</span>
              </div>
              <div className={styles.canvas}
                onContextMenu={event => {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  openBubble("canvas", event.clientX - rect.left, event.clientY - rect.top, spec.blocks.length === 0 ? "" : spec.blocks[spec.blocks.length - 1]!.id);
                }}
                onClick={event => {
                  if (!placing) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  openBubble("canvas", event.clientX - rect.left, event.clientY - rect.top, spec.blocks.length === 0 ? "" : spec.blocks[spec.blocks.length - 1]!.id);
                  setPlacing(false);
                }}>
                {pins.some(pin => pin.surface === "canvas") ? null : (
                  <p className={styles.canvasHint}>在空白处<b>右键</b>（或先点「＋ 想法」再点一下）写下你的想法。</p>) }
                {pins.map((pin, index) => pin.surface === "canvas" ? (
                  <Bubble key={pin.id} pin={pin} index={index} disabled={aiBusy} onPatch={changes => patchPin(pin.id, changes)}
                    onDelete={() => setPins(current => current.filter(item => item.id !== pin.id))} />
                ) : null)}
              </div>
            </div>) : (
            <div className={styles.preview} style={{ position: "relative", maxWidth: previewMode === "desktop" ? 1440 : previewMode === "tablet" ? 768 : 375 }}
              onDragOver={event => {
                if (!event.dataTransfer.types.includes("application/x-event-site-design")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={event => {
                const id = event.dataTransfer.getData("application/x-event-site-design");
                if (id === "") return;
                event.preventDefault();
                applyDesign(id);
              }}
              onPointerDown={event => {
                if (event.button !== 0) return;
                const target = event.target as HTMLElement;
                if (target.closest("a") || target.closest("button") || target.closest("input") || target.closest("textarea") || target.closest("[data-bubble]")) return;
                const rect = event.currentTarget.getBoundingClientRect();
                setMarquee({ x1: event.clientX - rect.left, y1: event.clientY - rect.top, x2: event.clientX - rect.left, y2: event.clientY - rect.top });
              }}
              onPointerMove={event => {
                if (marquee === null) return;
                const rect = event.currentTarget.getBoundingClientRect();
                setMarquee(current => current === null ? current : { ...current, x2: event.clientX - rect.left, y2: event.clientY - rect.top });
              }}
              onPointerUp={event => {
                if (marquee === null) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const box = {
                  left: Math.min(marquee.x1, marquee.x2), top: Math.min(marquee.y1, marquee.y2),
                  right: Math.max(marquee.x1, marquee.x2), bottom: Math.max(marquee.y1, marquee.y2),
                };
                setMarquee(null);
                if (box.right - box.left < 24 || box.bottom - box.top < 24) return;
                const hits: string[] = [];
                for (const element of event.currentTarget.querySelectorAll("[data-block-id]")) {
                  const bounds = element.getBoundingClientRect();
                  const local = { left: bounds.left - rect.left, top: bounds.top - rect.top, right: bounds.right - rect.left, bottom: bounds.bottom - rect.top };
                  if (local.left < box.right && local.right > box.left && local.top < box.bottom && local.bottom > box.top) {
                    const id = element.getAttribute("data-block-id");
                    if (id !== null && !hits.includes(id)) hits.push(id);
                  }
                }
                if (hits.length === 0) { setNotice("这一片没有区块；先在左边组件箱加一块。"); return; }
                if (hits.length > 20) { setNotice("一次最多圈 20 块（模块的批注上限），请分两次。"); return; }
                openBubble("area", box.left, box.top, hits[0]!, hits);
              }}
              onContextMenu={event => {
                event.preventDefault();
                const target = (event.target as HTMLElement).closest("[data-block-id]");
                const blockId = target?.getAttribute("data-block-id") ?? (spec.blocks.length === 0 ? "" : spec.blocks[spec.blocks.length - 1]!.id);
                const rect = event.currentTarget.getBoundingClientRect();
                openBubble("preview", event.clientX - rect.left, event.clientY - rect.top, blockId);
              }}>
              <EventSiteRenderer
                spec={spec} layout={layout} mode={previewMode === "mobile" ? "mobile" : "desktop"}
                editable={{ render: (blockId, node, body) => (
                  <BlockFrame key={blockId} block={node} disabled={busy}
                    selected={selectedId === blockId} editing={editingId === blockId}
                    onSelect={setSelectedId}
                    onMove={delta => moveBlock(blockId, delta)}
                    onDelete={() => removeBlock(blockId)}
                    onStartEdit={() => setEditingId(blockId)}
                    onDoneEdit={() => setEditingId(null)}
                    onText={changes => patchBlock(blockId, changes)}
                    onAddAfter={() => { setSelectedId(blockId); document.getElementById("event-site-palette")?.scrollIntoView({ block: "center", behavior: "smooth" }); }}>
                    {body}
                  </BlockFrame>) }}
                facts={{
                  registrationCloses: facts?.registrationCloses ?? null, submissionCloses: facts?.submissionCloses ?? null,
                  startsAt: facts?.startsAt ?? null, endsAt: facts?.endsAt ?? null,
                  scheduleNodes: (facts?.scheduleNodes ?? []).map(node => ({ id: node.id, title: node.title, startsAt: node.at, kind: node.kind })),
                  faqEntries: [...(facts?.faqEntries ?? [])],
                }}
                actionHref={target => `/competitions/${encodeURIComponent(eventId)}/${target === "register" ? "register" : target === "submit" ? "submit" : "results"}`}
                eventTitle={context?.eventTitle ?? "预览：专属页"} organizerName="" canonicalHref={`/competitions/${encodeURIComponent(eventId)}`} publishedAt={null}
              />
              {marquee === null ? null : (
                <div className={styles.marquee} style={{ left: Math.min(marquee.x1, marquee.x2), top: Math.min(marquee.y1, marquee.y2), width: Math.abs(marquee.x2 - marquee.x1), height: Math.abs(marquee.y2 - marquee.y1) }} />)}
              {pins.map((pin, index) => pin.surface === "preview" || pin.surface === "area" ? (
                <Bubble key={pin.id} pin={pin} index={index} disabled={aiBusy} onPatch={changes => patchPin(pin.id, changes)}
                  onDelete={() => setPins(current => current.filter(item => item.id !== pin.id))} />
              ) : null)}
            </div>) }
          {droppedDesign === null ? null : (
            <div className={styles.bar}>
              <span className={styles.rowMeta}>已套用「{designPreset(droppedDesign)?.name ?? ""}」的视觉。</span>
              <button type="button" className={styles.iconButton} disabled={aiBusy}
                onClick={() => { const preset = designPreset(droppedDesign); if (preset !== null) void generate(preset.brief); }}>
                让 AI 按这个风格改写
              </button>
              <button type="button" className={styles.iconButton} onClick={() => setDroppedDesign(null)}>只换视觉</button>
            </div>) }
          {streamedDrafts.length > 0 ? (
            <p className={styles.rowMeta}>流式已收到 {streamedBlocks} 块，正在等整页校验通过（校验完才会替换画布）。</p>) : null}
          {spec.blocks.length === 0 && surfaceMode === "editor" ? (
            <p className={styles.emptyHint}>这是空页——也合法。左边点一块加入，或右键画布写一句想法让 AI 加。</p>) : null}
        </main>

        {/* 右栏：属性 + AI */}
        <aside className={styles.rightCol}>
          <section className={styles.pane} aria-label="外观">
            <p className={styles.sectionTitle}>外观</p>
            <div className={styles.bar}>
              {(["classic", "dark", "paper", "neon"] as const).map(skin => (
                <button type="button" key={skin} className={styles.iconButton}
                  aria-pressed={(spec.skin ?? "classic") === skin}
                  onClick={() => applySpec(current => ({ ...current, skin }))}>
                  {skin === "classic" ? "暖白" : skin === "dark" ? "海报" : skin === "paper" ? "出版" : "霓虹"}
                </button>))}
            </div>
            <p className={styles.rowMeta}>只有平台预置的几套，不能自定义颜色或 CSS。</p>
          </section>

          <section className={styles.pane} aria-label="属性">
            <p className={styles.sectionTitle}>属性</p>
            {selected === undefined ? (
              <p className={styles.rowMeta}>在画布上点一块开始改。</p>) : (
              <Inspector block={selected} contentBlocks={contentBlocks} disabled={busy || aiBusy} refineText={refineText} onRefineText={setRefineText}
                onRefine={instruction => void refine(selected.id, instruction)} pendingAsset={pendingAsset} pendingHint={pendingHint}
                onUploadImage={file => void uploadImage(file)} onChange={changes => patchBlock(selected.id, changes)} />) }
          </section>

          <details className={styles.pane}>
            <summary className={styles.sectionTitle}>AI 生成</summary>
            <div className={styles.field}><span>你想让这页看起来像什么？</span>
              <textarea rows={3} maxLength={1000} value={intent.notes}
                placeholder="一句话就行，例如：要突出报名只剩三天，语气紧迫一点"
                onChange={event => setIntent(current => ({ ...current, notes: event.target.value }))} /></div>
            <div className={styles.bar}>
              {["突出报名截止只剩 3 天", "要有赞助商墙和 FAQ", "语气正式，像学术会议"].map(example => (
                <button type="button" key={example} className={styles.chipButton} disabled={aiBusy}
                  onClick={() => setIntent(current => ({ ...current, notes: example }))}>{example}</button>))}
            </div>
            <div className={styles.bar}>
              <button type="button" className={styles.iconButton} disabled={aiBusy} onClick={() => void generate()}>{aiBusy ? "生成中…" : "生成草案"}</button>
              {cancelController === null ? null : <button type="button" className={styles.iconButton} onClick={() => cancelController.abort()}>取消</button>}
              <button type="button" className={styles.iconButton} disabled={aiBusy} onClick={() => void suggest()}>建议</button>
            </div>
            <label className={styles.rowMeta}><input type="checkbox" checked={realtime} onChange={event => toggleRealtime(event.target.checked)} /> 实时生成（流式）</label>
            <p className={styles.rowMeta}>
              {streamedBlocks > 0 ? `已生成 ${streamedBlocks} 块…` : capability === null ? "正在检测生成能力…"
                : capability.stream ? "当前提供方支持流式，开启后会逐块出现。" : "当前提供方不支持流式：开启也只做一次性生成。"}
            </p>
            <details><summary className={styles.rowMeta}>更多选项</summary>
              <div className={styles.field}><span>比赛类型</span>
                <select value={intent.kind} onChange={event => setIntent(current => ({ ...current, kind: event.target.value }))}>
                  {["校园赛", "商业赛", "社区赛", "其他"].map(kind => <option key={kind} value={kind}>{kind}</option>)}
                </select></div>
              <div className={styles.field}><span>目标人群</span><input value={intent.audience} maxLength={200} onChange={event => setIntent(current => ({ ...current, audience: event.target.value }))} /></div>
              <div className={styles.field}><span>想强调</span><input value={intent.emphasis} onChange={event => setIntent(current => ({ ...current, emphasis: event.target.value }))} /></div>
              <div className={styles.field}><span>语气</span><input value={intent.tone} maxLength={60} onChange={event => setIntent(current => ({ ...current, tone: event.target.value }))} /></div>
            </details>
            {suggestions === null ? null : (
              <ul className={styles.layers}>
                {suggestions.suggestions.map(item => (
                  <li className={styles.layerRow} key={item.id}>
                    <span className={styles.layerLabel}><strong>{item.title}</strong><span className={styles.rowMeta}>{item.rationale}</span></span>
                    <button type="button" className={styles.chipButton} disabled={aiBusy || item.patch === undefined}
                      onClick={() => applySuggestion(item)}>应用</button>
                  </li>))}
              </ul>) }
          </details>

          <details className={styles.pane}>
            <summary className={styles.sectionTitle}>批注（{pins.length}）</summary>
            <div className={styles.bar}>
              <button type="button" className={styles.iconButton} disabled={aiBusy} onClick={addPin}>＋ 批注</button>
              <button type="button" className={styles.iconButton} disabled={aiBusy || pins.length === 0} onClick={() => void applyPins()}>应用批注</button>
            </div>
            {pins.length === 0 ? <p className={styles.rowMeta}>还没有批注。右键画布，或在选中块后点「＋ 批注」。</p> : (
              <ul className={styles.layers}>
                {pins.map((pin, index) => (
                  <li className={styles.layerRow} key={pin.id}>
                    <span className={styles.layerLabel}>{index + 1}. {pin.instruction === "" ? "（空）" : pin.instruction}</span>
                    <span className={styles.layerTools}>
                      <button type="button" aria-label="删除批注" onClick={() => setPins(current => current.filter(item => item.id !== pin.id))}>✕</button>
                    </span>
                  </li>))}
              </ul>) }
          </details>

          <details className={styles.pane}>
            <summary className={styles.sectionTitle}>机构模板</summary>
            <div className={styles.bar}>
              <button type="button" className={styles.iconButton} disabled={aiBusy} onClick={() => void loadTemplates(view.organizationId)}>查看模板</button>
            </div>
            <div className={styles.field}><span>存为模板</span>
              <input aria-label="模板名字" placeholder="例如「校园赛标准页」" value={templateName} maxLength={60}
                onChange={event => setTemplateName(event.target.value)} /></div>
            <button type="button" className={styles.iconButton} disabled={aiBusy || templateName.trim() === ""}
              onClick={() => void saveTemplate(view.organizationId)}>保存当前草稿为模板</button>
            {templateError === "" ? null : <p className={styles.rowMeta}>{templateError}</p>}
            {templates === null ? null : templates.length === 0 ? <p className={styles.rowMeta}>这个机构还没有模板。</p> : (
              <ul className={styles.layers}>
                {templates.map(item => (
                  <li className={styles.layerRow} key={item.id}>
                    <span className={styles.layerLabel}>{item.name}<span className={styles.rowMeta}> · 第 {item.revision} 版</span></span>
                    <span className={styles.layerTools}>
                      <button type="button" aria-label="套用" onClick={() => void applyTemplate(item.id)}>套用</button>
                      <button type="button" aria-label="删除模板" onClick={() => void deleteTemplate(view.organizationId, item.id)}>✕</button>
                    </span>
                  </li>))}
              </ul>) }
          </details>

          <details className={styles.pane}>
            <summary className={styles.sectionTitle}>历史版本</summary>
            <div className={styles.bar}>
              <button type="button" className={styles.iconButton} disabled={aiBusy} onClick={() => void loadHistory()}>查看历史</button>
              <span className={styles.rowMeta}>只保留最近 20 版；回退只改草稿。</span>
            </div>
            {historyError === "" ? null : <p className={styles.rowMeta}>{historyError}</p>}
            {history === null ? null : history.revisions.length === 0 ? <p className={styles.rowMeta}>还没有历史。</p> : (
              <ul className={styles.layers}>
                {history.revisions.map(item => (
                  <li className={styles.layerRow} key={item.revision}>
                    <span className={styles.layerLabel}>第 {item.revision} 版<span className={styles.rowMeta}> · {new Date(item.createdAt).toLocaleString("zh-CN")}</span></span>
                    <span className={styles.layerTools}>
                      <button type="button" aria-label="回退" disabled={aiBusy} onClick={() => void restoreRevision(item.revision)}>回退</button>
                    </span>
                  </li>))}
              </ul>) }
          </details>
        </aside>
      </div>

      {shortcutsOpen ? (
        <div className={styles.modal} onClick={() => setShortcutsOpen(false)}>
          <div className={styles.modalCard} onClick={event => event.stopPropagation()}>
            <p className={styles.sectionTitle}>快捷键</p>
            <ul className={styles.layers}>
              {[["/", "呼出组件箱"], ["Ctrl/⌘ + Z", "撤销"], ["Shift + Ctrl/⌘ + Z", "重做"], ["Ctrl/⌘ + S", "立即保存"], ["↑ / ↓", "移动选中区块"], ["Ctrl/⌘ + Enter", "发布"], ["Esc", "取消选择"]].map(([key, label]) => (
                <li className={styles.layerRow} key={key}><span className={styles.layerLabel}>{label}</span><span className={styles.code}>{key}</span></li>))}
            </ul>
            <button type="button" className={styles.iconButton} onClick={() => setShortcutsOpen(false)}>关闭</button>
          </div>
        </div>) : null}

    </div>);
}

function CopyButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className={styles.iconButton} onClick={() => {
      void navigator.clipboard?.writeText(`${window.location.origin}${text}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => setCopied(false));
    }}>{copied ? "已复制" : "复制链接"}</button>);
}

function Inspector({ block, contentBlocks, disabled, refineText, onRefineText, onRefine, pendingAsset, pendingHint, onUploadImage, onChange }: {
  readonly block: EventSiteBlockNode; readonly contentBlocks: readonly EventSiteBlockNode[];
  readonly disabled: boolean; readonly refineText: string; readonly onRefineText: (value: string) => void;
  readonly onRefine: (instruction: string) => void; readonly pendingAsset: string | null; readonly pendingHint: UploadHint | null;
  readonly onUploadImage: (file: File) => void; readonly onChange: (changes: Record<string, unknown>) => void;
}) {
  const declaration = blockDeclaration(block.kind);
  const rules = declaration.textRules;
  if (isActionBlock(block)) {
    return <p className={styles.rowMeta}>动作跳板：目标是平台固定的「{declaration.label}」，不能改 href、不能加表单。</p>;
  }
  if (isAiContainerBlock(block)) {
    return (
      <div>
        <label className={styles.field}><span>职责（一行话，可空）</span>
          <input value={block.duty ?? ""} maxLength={200} disabled={disabled} onChange={event => onChange({ duty: event.target.value.trim() === "" ? null : event.target.value })} />
        </label>
        <label className={styles.field}><span>它管的区块</span>
          <select multiple value={[...block.manages]} disabled={disabled} size={Math.min(6, Math.max(3, contentBlocks.length))}
            onChange={event => onChange({ manages: Array.from(event.target.selectedOptions).map(option => option.value) })}>
            {contentBlocks.map(item => <option key={item.id} value={item.id}>{blockDeclaration(item.kind).label} · {item.id.slice(-4)}</option>)}
          </select>
        </label>
        <p className={styles.rowMeta}>一块只能属于一个容器；容器不能嵌套；一页最多 3 个。</p>
        <div className={styles.field}><span>让 AI 改它管的块（只改这里，不碰框外）</span>
          <input value={refineText} maxLength={200} disabled={disabled || block.duty === null || block.manages.length === 0}
            placeholder={block.duty === null ? "先写职责" : block.manages.length === 0 ? "先把区块拖进来" : "例如：把这两块语气统一成更正式"}
            onChange={event => onRefineText(event.target.value)} />
        </div>
        <button type="button" className={styles.iconButton} disabled={disabled || block.duty === null || block.manages.length === 0 || refineText.trim() === ""} onClick={() => onRefine(refineText)}>让 AI 改这块</button>
      </div>);
  }
  return (
    <div>
      <label className={styles.field}><span>变体</span>
        <select value={block.variant} disabled={disabled} onChange={event => onChange({ variant: event.target.value })}>
          {declaration.variants.map(variant => <option key={variant} value={variant}>{variant}</option>)}
        </select>
      </label>
      <label className={styles.field}><span>优先级（决定手机顺序）</span>
        <select value={block.priority} disabled={disabled} onChange={event => onChange({ priority: Number(event.target.value) as EventSitePriority })}>
          {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label className={styles.field}><span>手机上折叠</span>
        <input type="checkbox" checked={block.collapse} disabled={disabled} onChange={event => onChange({ collapse: event.target.checked })} />
      </label>
      {rules.maxHeading === 0 ? null : (
        <label className={styles.field}><span>标题（≤{rules.maxHeading}）</span>
          <input value={block.heading ?? ""} maxLength={rules.maxHeading} disabled={disabled} onChange={event => onChange({ heading: event.target.value.trim() === "" ? null : event.target.value })} />
        </label>) }
      {rules.maxText === 0 ? null : (
        <label className={styles.field}><span>文案（≤{rules.maxText}，纯文本）</span>
          <textarea rows={4} value={block.text ?? ""} maxLength={rules.maxText} disabled={disabled} onChange={event => onChange({ text: event.target.value.trim() === "" ? null : event.target.value })} />
        </label>) }
      {declaration.factClass ? (
        <label className={styles.field}><span>数据来源（只能绑定，不能手写）</span>
          <select value={block.binding?.field ?? ""} disabled={disabled} onChange={event => {
            const field = event.target.value as EventSiteBindingField;
            onChange({ binding: { source: EVENT_SITE_BINDING_FIELD_SOURCE[field], field } });
          }}>
            {declaration.allowedBindingFields.map(field => <option key={field} value={field}>{field}</option>)}
          </select>
        </label>) : null}
      {rules.maxItems === 0 ? null : (
        <div className={styles.field}><span>条目（≤{rules.maxItems}）</span>
          {block.items.map((item, index) => (
            <div key={index} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              <input value={item.heading} maxLength={rules.maxItemHeading} disabled={disabled} placeholder="条目标题"
                onChange={event => onChange({ items: block.items.map((entry, at) => at === index ? { ...entry, heading: event.target.value } : entry) })} />
              <input value={item.text ?? ""} maxLength={rules.maxItemText} disabled={disabled} placeholder="条目说明（可空）"
                onChange={event => onChange({ items: block.items.map((entry, at) => at === index ? { ...entry, text: event.target.value.trim() === "" ? null : event.target.value } : entry) })} />
              <button type="button" className={styles.iconButton} disabled={disabled} aria-label="删除条目"
                onClick={() => onChange({ items: block.items.filter((_, at) => at !== index) })}>✕</button>
            </div>))}
          {block.items.length >= rules.maxItems ? null : (
            <button type="button" className={styles.iconButton} disabled={disabled}
              onClick={() => onChange({ items: [...block.items, { heading: "", text: null, image: null }] })}>＋ 加一条</button>) }
        </div>) }
      {declaration.carriesImage ? (
        <div className={styles.field}><span>图片（PNG/JPEG/WebP，≤2 MB，只存档不识别内容）</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled}
            onChange={event => { const file = event.target.files?.[0]; if (file) onUploadImage(file); }} />
        </div>) : null}
      {declaration.carriesImage && pendingHint !== null ? (
        <p className={styles.rowMeta}>按宽高比建议：{pendingHint.aspect} · 适合 {pendingHint.blocks.join(" / ")}</p>) : null}
      {declaration.carriesImage && pendingAsset !== null && (block.image === null || block.image.assetId !== pendingAsset) ? (
        <button type="button" className={styles.iconButton} disabled={disabled}
          onClick={() => onChange({ image: { assetId: pendingAsset, alt: block.heading ?? "图片", aspect: pendingHint?.aspect ?? "16:9" } })}>用这张图</button>) : null}
      {declaration.carriesImage && block.image !== null ? (
        <div>
          <label className={styles.field}><span>替代文本（给看不到图的人）</span>
            <input value={block.image.alt} maxLength={120} disabled={disabled}
              onChange={event => onChange({ image: { ...block.image!, alt: event.target.value } })} />
          </label>
          <label className={styles.field}><span>比例</span>
            <select value={block.image.aspect} disabled={disabled}
              onChange={event => onChange({ image: { ...block.image!, aspect: event.target.value } })}>
              {["16:9", "4:3", "1:1", "3:4"].map(aspect => <option key={aspect} value={aspect}>{aspect}</option>)}
            </select>
          </label>
        </div>) : null}
    </div>);
}

/**
 * 气泡：画布与预览共用的输入单元。只有一句话 + 三个选择，不做表单。
 * 收起后变成画布上的编号钉子，点一下重新打开。
 */
function Bubble({ pin, index, disabled, onPatch, onDelete }: {
  readonly pin: Pin; readonly index: number; readonly disabled: boolean;
  readonly onPatch: (changes: Partial<Pin>) => void; readonly onDelete: () => void;
}) {
  if (!pin.open) {
    return (
      <button type="button" data-bubble className={styles.chip} style={{ left: pin.x, top: pin.y }} aria-label={`想法 ${index + 1}`}
        onClick={() => onPatch({ open: true })}>{index + 1}</button>);
  }
  return (
    <div className={styles.bubble} data-bubble style={{ left: pin.x, top: pin.y }} onContextMenu={event => event.stopPropagation()}>
      {pin.blockIds !== undefined && pin.blockIds.length > 1 ? <p className={styles.rowMeta}>覆盖 {pin.blockIds.length} 块（会逐块改）</p> : null}
      <textarea autoFocus rows={3} value={pin.instruction} maxLength={200} disabled={disabled}
        placeholder="写下你的想法，例如：这里要一句更紧迫的报名提示"
        onChange={event => onPatch({ instruction: event.target.value })} />
      <div className={styles.bubbleRow}>
        <select value={pin.wantKind} disabled={disabled} onChange={event => onPatch({ wantKind: event.target.value as Pin["wantKind"] })}>
          <option value="insert">插入新区块</option>
          <option value="reword">改写这块</option>
          <option value="replace">替换这块</option>
        </select>
        {pin.wantKind === "insert" ? (
          <select value={pin.blockKind} disabled={disabled} onChange={event => onPatch({ blockKind: event.target.value })}>
            {["highlights", "richText", "countdown", "timeline", "sponsorWall", "peopleWall", "faq", "bannerImage"].map(kind => (
              <option key={kind} value={kind}>{blockDeclaration(kind as never).label}</option>))}
          </select>) : null}
      </div>
      <div className={styles.bubbleRow}>
        <label className={styles.rowMeta}><input type="checkbox" checked={pin.mobileOnly} disabled={disabled}
          onChange={event => onPatch({ mobileOnly: event.target.checked })} /> 只影响手机</label>
        <button type="button" className={styles.chipButton} disabled={disabled} onClick={() => onPatch({ open: false })}>收起</button>
        <button type="button" className={styles.chipButton} disabled={disabled} onClick={onDelete}>删除</button>
      </div>
    </div>);
}

/**
 * 画布上的区块外壳：选中、悬浮工具栏、就地改文案。
 * 编辑器把这一层交给渲染器，所以公开页与编辑器用的是**同一个**渲染组件。
 */
function BlockFrame({ block, selected, editing, disabled, onSelect, onMove, onDelete, onStartEdit, onDoneEdit, onText, onAddAfter, children }: {
  readonly block: EventSiteBlockNode; readonly selected: boolean; readonly editing: boolean; readonly disabled: boolean;
  readonly onSelect: (id: string) => void; readonly onMove: (delta: number) => void; readonly onDelete: () => void;
  readonly onStartEdit: () => void; readonly onDoneEdit: () => void;
  readonly onText: (changes: Record<string, unknown>) => void; readonly onAddAfter: () => void;
  readonly children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const declaration = blockDeclaration(block.kind);
  const rules = declaration.textRules;
  const showTools = (hover || selected) && !disabled && !isActionBlock(block);
  const headingValue = "heading" in block ? block.heading ?? "" : "";
  const textValue = "text" in block ? block.text ?? "" : "";
  return (
    <div data-block-id={block.id}
      className={`${styles.blockFrame} ${selected ? styles.blockFrameSelected : ""}`}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={event => {
        const target = event.target as HTMLElement;
        if (target.closest("a") || target.closest("button") || target.closest("input") || target.closest("textarea")) return;
        onSelect(block.id);
      }}>
      {editing ? (
        <div className={styles.inlineEditor} onClick={event => event.stopPropagation()}>
          <p className={styles.rowMeta}>{declaration.label} · {declaration.hint}</p>
          {rules.maxHeading === 0 ? null : (
            <input autoFocus value={headingValue} maxLength={rules.maxHeading} placeholder="标题"
              onChange={event => onText({ heading: event.target.value === "" ? null : event.target.value })} />) }
          {rules.maxText === 0 ? null : (
            <textarea autoFocus={rules.maxHeading === 0} rows={3} value={textValue} maxLength={rules.maxText} placeholder="文案（纯文本）"
              onChange={event => onText({ text: event.target.value === "" ? null : event.target.value })} />) }
          {rules.maxHeading === 0 && rules.maxText === 0 ? <p className={styles.rowMeta}>这块没有可改的文案，去右侧设置里调。</p> : null}
          <div className={styles.bubbleRow}><button type="button" className={styles.chipButton} onClick={onDoneEdit}>完成</button></div>
        </div>) : null}
      {children}
      {showTools ? (
        <div className={styles.blockTools}>
          <button type="button" aria-label="上移" onClick={event => { event.stopPropagation(); onMove(-1); }}>↑</button>
          <button type="button" aria-label="下移" onClick={event => { event.stopPropagation(); onMove(1); }}>↓</button>
          <button type="button" aria-label="改文案" onClick={event => { event.stopPropagation(); onSelect(block.id); onStartEdit(); }}>✎</button>
          <button type="button" aria-label="在下面加一块" onClick={event => { event.stopPropagation(); onAddAfter(); }}>＋</button>
          <button type="button" aria-label="删除这一块" onClick={event => { event.stopPropagation(); onDelete(); }}>✕</button>
        </div>) : null}
    </div>);
}
