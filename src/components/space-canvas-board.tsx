"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { api, message, useApi, ApiError } from "./client-api.ts";
import type { CurrentPlanningView } from "../modules/planning/types.ts";
import type { ProjectDetail } from "./projects-client.tsx";
import { SpaceTodosPanel } from "./space-todos.tsx";
import { SpaceTeammatesPanel } from "./space-teammates.tsx";
import { SpaceDocumentsPanel } from "./space-documents.tsx";
import { SpacePathCanvas } from "./space-path-canvas.tsx";
import { SpaceCollaborationOverview } from "./space-collaboration-overview.tsx";
import { SpaceAssistantFloat, SPACE_ASSISTANT_OPEN_EVENT } from "./space-assistant-float.tsx";
import { SpaceResourcePanel, SpaceScopeCutPanel } from "./space-resource.tsx";
import { SpaceInvitationTrigger } from "./space-invitation-trigger.tsx";
import { TeamSupervisionPanel } from "../modules/team-supervision/ui.ts";
import { SpaceChanges } from "../modules/space-changes/ui.ts";
import {
  CARD, COMPONENT_HINTS, COMPONENT_LABELS, SCALE_MIN, SCALE_MAX, SPACE_COMPONENT_KINDS, availableKinds, initialCollaborationCanvas,
  heightOf, moveOnCanvas, normalizeCanvasLayout, removeFromCanvas, resizeOnCanvas, scaleOf,
  toggleCanvasCollapsed, toggleFromCanvas, wheelScaleDelta, widthOf,
  type CanvasLayout, type CanvasPlacement, type SpaceComponentKind,
} from "../modules/space-workflow/canvas-board.ts";
import {
  LONG_PRESS_MS, SPACE_CANVAS_GESTURE_EVENT, canUseCanvasGesture, canvasSelectionRect, intersectingCanvasItems, isLongPressClick,  movedBeforeLongPress, planningReadPresentation, scaleCanvasGroup, translateCanvasGroup,
  type CanvasGestureRegion, type CanvasPoint, type CanvasSelectionRect, type LongPressClickFence,
} from "../modules/space-workflow/canvas-gestures.ts";
import {
  ANNOTATION_COLORS, TOOL_HINTS, TOOL_LABELS, addNote, addStroke, appendPoint, clearAnnotations, emptyAnnotations,
  eraseStrokes, hasAnnotations, normalizeNoteText, noteAt, removeNotes, redoAnnotation, strokesAt, toolColor, toolWidth,
  undoAnnotation, type AnnotationState, type AnnotationStroke, type AnnotationTool,
} from "../modules/space-workflow/annotation.ts";
import styles from "./space-canvas-board.module.css";

interface SavedLayout { revision: number; items: unknown }
type View = "collaboration" | "canvas";

/** 箭头：从起点指向终点，带一个简单的箭头头部；用来"指这里"比手绘更清楚。 */
function ArrowShape({ stroke }: { stroke: AnnotationStroke }) {
  const start = stroke.points[0];
  const end = stroke.points.at(-1) ?? start;
  if (!start || !end) return null;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const size = 6 + stroke.width * 2;
  const head = [
    { x: end.x - size * Math.cos(angle - Math.PI / 7), y: end.y - size * Math.sin(angle - Math.PI / 7) },
    { x: end.x - size * Math.cos(angle + Math.PI / 7), y: end.y - size * Math.sin(angle + Math.PI / 7) },
  ];
  return <g>
    <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round"/>
    <polygon points={`${end.x},${end.y} ${head[0]!.x},${head[0]!.y} ${head[1]!.x},${head[1]!.y}`} fill={stroke.color}/>
  </g>;
}
type Measure = { width: number; height: number };
type DragGesture = { id: string; pointerId: number; target: HTMLElement; startX: number; startY: number; scrollX: number; scrollY: number; items: readonly CanvasPlacement[]; moved: boolean; active: boolean; mobile: boolean };
type SelectionGesture = { pointerId: number; target: HTMLElement; startX: number; startY: number; start: CanvasPoint; active: boolean };
const SHARE_ANCHORS = new Set(["#space-todos", "#space-teammates", "#space-documents", "#space-path-line"]);
const EDITOR_SELECTOR = "input,select,textarea,[contenteditable]:not([contenteditable=false]),[role=textbox]";
/**
 * 该元素（或它内部的后代）是否**还有可滚动的内容**。
 *
 * 用来决定编辑框里的滚轮归谁：内部还有内容可滚 → 留给原生滚动；已经滚到底或本来就不可滚 → 允许缩放卡片。
 * 文档正文 `textarea` 设了 `max-height:none`、内部不滚动，所以文档卡可以正常缩放（修用户报的"文档组件无法放大缩小"）。
 */
function hasScrollableContent(target: Element): boolean {
  const candidates: Element[] = [target, ...Array.from(target.querySelectorAll("*")).slice(0, 40)];
  for (const node of candidates) {
    const element = node as HTMLElement;
    if (element.scrollHeight - element.clientHeight > 2 || element.scrollWidth - element.clientWidth > 2) return true;
  }
  return false;
}

function gestureRegion(target: Element, card: Element): CanvasGestureRegion {
  // Protect independent inner gestures before considering any outer opt-in.
  if (target.closest("dialog,[role=dialog]")) return "dialog";
  if (target.closest("[data-graph-node],[data-space-flow-node],[data-space-flow-surface]")) return "graph-node";
  if (target.closest("[data-canvas-options]")) return "options";
  if (target.closest(EDITOR_SELECTOR)) return "editor";
  if (target === card) return "surface";
  const control = target.closest("a,button,summary,[role=button]");
  if (control) return control.matches("[data-canvas-longpress]") && !control.matches(":disabled,[aria-disabled=true]") ? "safe-control" : "control";
  if (target.closest("[data-space-document-body],[data-space-document-text]")) return "document-text";
  return "content";
}

/** Private free canvas. Layout preferences never change project or task facts. */
export function SpaceCanvasBoard({ detail, reload, membersError }: { detail: ProjectDetail; reload: () => Promise<void>; membersError?: string }) {
  const projectId = detail.project.id;
  const path = `/projects/${encodeURIComponent(projectId)}/space-canvas`;
  const remote = useApi<SavedLayout>(path);
  const current = useApi<CurrentPlanningView>(`/projects/${encodeURIComponent(projectId)}/plans/current`, { timeoutMs: 15_000 });
  const [lastPlanningError, setLastPlanningError] = useState<{ projectId: string; error: string | null }>({ projectId, error: null });
  const planningState = planningReadPresentation({ hasData: current.data !== null, loading: current.loading,
    error: current.error?.message ?? null, previousError: lastPlanningError.projectId === projectId ? lastPlanningError.error : null });
  useEffect(() => {
    if (!current.loading) setLastPlanningError({ projectId, error: current.error?.message ?? null });
  }, [projectId, current.loading, current.error]);
  const currentReload = useRef(current.reload); currentReload.current = current.reload;
  const membersReload = useRef(reload); membersReload.current = reload;
  const [view, setView] = useState<View>("canvas");
  const [narrow, setNarrow] = useState(false);
  const [layout, setLayout] = useState<CanvasLayout>(() => initialCollaborationCanvas());
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const [layoutReady, setLayoutReady] = useState(false);
  const [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false), savingRef = useRef(false), dirtyRef = useRef(false);
  const [recovering, setRecovering] = useState(false);
  const recoveringRef = useRef(false), saveTimer = useRef<number | null>(null);
  const savedRevision = useRef(0), pendingSave = useRef<CanvasLayout | null>(null);
  const mounted = useRef(true);
  const [removed, setRemoved] = useState<Record<string, CanvasPlacement>>({});
  const removedRef = useRef(removed); removedRef.current = removed;
  const [measurements, setMeasurements] = useState<Record<string, Measure>>({});
  const surface = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [dragPos, setDragPos] = useState<{ id: string; items: readonly CanvasPlacement[] } | null>(null);
  const drag = useRef<DragGesture | null>(null);
  const longPressClick = useRef<LongPressClickFence | null>(null);
  const dragPosition = useRef<typeof dragPos>(null);
  const pressTimer = useRef<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const selectedRef = useRef<readonly string[]>([]);
  const selectionGesture = useRef<SelectionGesture | null>(null);
  const selectionTimer = useRef<number | null>(null);
  const [marquee, setMarquee] = useState<{ rect: CanvasSelectionRect; ids: readonly string[] } | null>(null);
  const marqueeRef = useRef<typeof marquee>(null);
  const [dragOrder, setDragOrder] = useState<readonly CanvasPlacement[] | null>(null);
  const dragOrderRef = useRef<readonly CanvasPlacement[] | null>(null);
  const pristineLayout = useRef(false);
  const openStep = useRef<((id: string) => void) | null>(null);
  const [refreshing, setRefreshing] = useState(false), [hintVisible, setHintVisible] = useState(false);
  // 画布批注（用户要求：右击栏含画笔与橡皮）。**只属于当前浏览器会话**：不落库、刷新即清、队友看不到。
  const [annotation, setAnnotation] = useState<AnnotationState>(emptyAnnotations);
  const annotationRef = useRef(annotation); annotationRef.current = annotation;
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("pen");
  const annotationToolRef = useRef(annotationTool); annotationToolRef.current = annotationTool;
  const [annotating, setAnnotating] = useState(false);
  const annotatingRef = useRef(annotating); annotatingRef.current = annotating;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; instanceId: string | null; canvasX: number; canvasY: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  /** 菜单实际高度：测量后**触发重排**，否则翻转逻辑拿不到高度、第一帧就超出视口。 */
  const [contextMenuHeight, setContextMenuHeight] = useState(0);
  // 用 layout effect 在绘制前测量：把真实高度写进 state，让菜单能在同一帧内被摆正。
  useLayoutEffect(() => {
    if (!contextMenu) { setContextMenuHeight(0); return; }
    const node = contextMenuRef.current;
    if (!node) return;
    const height = Math.ceil(node.getBoundingClientRect().height);
    if (height > 0 && height !== contextMenuHeight) setContextMenuHeight(height);
  }, [contextMenu, contextMenuHeight]);
  const [draft, setDraft] = useState<AnnotationStroke | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ canvasX: number; canvasY: number; text: string } | null>(null);
  const drawing = useRef<{ pointerId: number; target: SVGSVGElement } | null>(null);
  const strokeSeq = useRef(0);
  // 「组件」栏：点空白处收起（用户 2026-10-13 要求）。
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteRef = useRef<HTMLDetailsElement | null>(null);
  const viewKey = `hackathon.space.view.v3.${projectId}.${detail.membership.userId}`;
  const readOnly = detail.project.stage === "archived";
  const hintKey = `hackathon.space.longpress.v3.${detail.membership.userId}`;

  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    if (selectionTimer.current !== null) window.clearTimeout(selectionTimer.current);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
  }; }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => { endDrag(true); endSelection(true); selectCards([]); setNarrow(media.matches); };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    try { if (window.localStorage.getItem(viewKey) === "collaboration") setView("collaboration"); } catch { /* Preference only. */ }
  }, [viewKey]);
  useEffect(() => { try { setHintVisible(window.localStorage.getItem(hintKey) !== "seen"); } catch { setHintVisible(true); } }, [hintKey]);
  function dismissHint() { setHintVisible(false); try { window.localStorage.setItem(hintKey, "seen"); } catch { /* Hint only. */ } }
  useEffect(() => {
    if (!remote.data || dirtyRef.current || savingRef.current || recoveringRef.current) return;
    pristineLayout.current = remote.data.revision === 0 && Array.isArray(remote.data.items) && !remote.data.items.length;
    const next = pristineLayout.current ? initialCollaborationCanvas() : normalizeCanvasLayout(remote.data.items, remote.data.revision);
    savedRevision.current = next.revision;
    layoutRef.current = next; setLayout(next); setLayoutReady(true);
  }, [remote.data]);

  // These GETs update existing facts only; background tabs do not poll or trigger AI work.
  useEffect(() => {
    let active = true, refreshing = false;
    const refresh = async () => {
      if (!active || refreshing || document.visibilityState !== "visible") return;
      refreshing = true;
      try { await Promise.all([currentReload.current(), membersReload.current()]); }
      finally { refreshing = false; }
    };
    const timer = window.setInterval(() => void refresh(), 15_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [projectId]);

  const setViewPreference = useCallback((next: View) => {
    endDrag(true); endSelection(true); selectCards([]); setView(next);
    try { window.localStorage.setItem(viewKey, next); } catch { /* Preference only. */ }
  }, [viewKey]);
  useEffect(() => {
    const reveal = () => {
      if (!SHARE_ANCHORS.has(window.location.hash) && !window.location.hash.startsWith("#space-document-")) return;
      // A teammate may not have added this card to their private free canvas.
      endDrag(true); endSelection(true); selectCards([]); setView("collaboration");
      window.requestAnimationFrame(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" }));
    };
    reveal(); window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [layoutReady]);

  const drainSave = useCallback(async () => {
    if (savingRef.current || conflictRef.current || recoveringRef.current || !pendingSave.current || !mounted.current) return;
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    savingRef.current = true; setSaving(true);
    try {
      while (pendingSave.current && mounted.current && !conflictRef.current) {
        const next = pendingSave.current; pendingSave.current = null;
        try {
          const saved = await api<SavedLayout>(path, { method: "PUT", body: { expectedRevision: savedRevision.current, items: next.items } });
          if (!mounted.current) return;
          savedRevision.current = saved.revision;
          // A newer gesture can arrive while this request is in flight; retain that preview.
          const latest = pendingSave.current ? { ...layoutRef.current, revision: saved.revision } : normalizeCanvasLayout(saved.items, saved.revision);
          layoutRef.current = latest; setLayout(latest);
          if (!pendingSave.current) { dirtyRef.current = false; setDirty(false); }
        } catch (reason) {
          if (!mounted.current) return;
          pendingSave.current = layoutRef.current;
          conflictRef.current = true; setConflict(true);
          const changedElsewhere = reason instanceof ApiError && (reason.code === "VERSION_CONFLICT" || reason.status === 409);
          setError(`${message(reason)} ${changedElsewhere ? "本次调整仍保留在屏幕上；请先核对已保存的摆放，避免覆盖另一个窗口。" : "本次调整仍保留在屏幕上，尚未确认保存成功。"}`);
        }
      }
    } finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  }, [path]);
  const persist = useCallback((next: CanvasLayout) => {
    if (recoveringRef.current) return;
    pristineLayout.current = false;
    layoutRef.current = next; setLayout(next); dirtyRef.current = true; setDirty(true); setNotice("");
    pendingSave.current = next;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { saveTimer.current = null; void drainSave(); }, 180);
  }, [drainSave]);

  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function readSavedLayout() {
    if (savingRef.current || recoveringRef.current) return;
    endDrag(true); endSelection(true); selectCards([]); recoveringRef.current = true; setRecovering(true); setError("");
    try {
      const saved = await api<SavedLayout>(path);
      pristineLayout.current = saved.revision === 0 && Array.isArray(saved.items) && !saved.items.length;
      const next = pristineLayout.current ? initialCollaborationCanvas() : normalizeCanvasLayout(saved.items, saved.revision);
      pendingSave.current = null; conflictRef.current = false; setConflict(false);
      dirtyRef.current = false; setDirty(false); savedRevision.current = next.revision;
      layoutRef.current = next; setLayout(next); setLayoutReady(true);
      setNotice("已读取保存的摆放，放弃本次未保存调整。");
    } catch (reason) { setError(message(reason)); } finally { recoveringRef.current = false; setRecovering(false); }
  }
  async function checkAndRetrySave() {
    if (savingRef.current || recoveringRef.current) return;
    endDrag(true); endSelection(true); selectCards([]); recoveringRef.current = true; setRecovering(true);
    let retry = false;
    try {
      const saved = await api<SavedLayout>(path);
      const normalized = normalizeCanvasLayout(saved.items, saved.revision);
      const sameItems = JSON.stringify(normalized.items) === JSON.stringify(normalizeCanvasLayout(layoutRef.current.items).items);
      if (sameItems) {
        savedRevision.current = saved.revision; pendingSave.current = null;
        conflictRef.current = false; setConflict(false); dirtyRef.current = false; setDirty(false);
        layoutRef.current = normalized; setLayout(normalized); setError(""); setNotice("已核对，本次摆放已保存。");
      } else if (saved.revision === savedRevision.current) {
        conflictRef.current = false; setConflict(false); setError(""); pendingSave.current = layoutRef.current;
        retry = true;
      } else {
        setError("服务器保存的摆放已被另一个窗口更新，本次调整仍保留在屏幕上。请先记录需要保留的调整，再读取已保存的摆放；不会自动覆盖其他窗口。");
      }
    } catch (reason) { setError(`${message(reason)} 本次调整仍保留，尚未确认保存成功。`); }
    finally { recoveringRef.current = false; setRecovering(false); }
    if (retry) void drainSave();
  }
  async function refreshFacts() {
    setRefreshing(true);
    try { await Promise.all([current.reload(), reload()]); }
    finally { setRefreshing(false); }
  }
  const readyStep = useCallback((open: (id: string) => void) => { openStep.current = open; }, []);
  const openNode = useCallback((id: string) => { openStep.current?.(id); }, []);
  const openAssistant = useCallback(() => window.dispatchEvent(new CustomEvent(SPACE_ASSISTANT_OPEN_EVENT, { detail: { projectId } })), [projectId]);

  const actualSize = useCallback((item: CanvasPlacement) => {
    const size = measurements[item.instanceId];
    return { width: (size?.width ?? (item.kind === "path" ? 1140 : widthOf(item))) * scaleOf(item), height: (size?.height ?? (item.collapsed ? 70 : item.kind === "path" ? 3000 : heightOf(item))) * scaleOf(item) };
  }, [measurements]);
  useEffect(() => {
    if (!pristineLayout.current || narrow || !layoutReady || view !== "canvas") return;
    const value = layoutRef.current;
    const top = value.items.filter(item => ["todos", "overview", "teammates", "supervision"].includes(item.kind));
    const pathItem = value.items.find(item => item.kind === "path");
    const topBottom = Math.max(24, ...top.map(item => item.y + actualSize(item).height));
    const pathY = topBottom + 48;
    const documentY = pathY + (pathItem ? actualSize(pathItem).height : 0) + 48;
    const next = { ...value, items: value.items.map(item => item.kind === "path" ? { ...item, y: pathY } : item.kind === "documents" ? { ...item, y: documentY } : item) };
    if (next.items.some((item, index) => item.y !== value.items[index]?.y)) { layoutRef.current = next; setLayout(next); }
    // Fresh defaults respond to real content measurements without saving or changing old layouts.
  }, [actualSize, layoutReady, narrow, view]);
  const previewPositions = useMemo(() => new Map(dragPos?.items.map(item => [item.instanceId, item]) ?? []), [dragPos]);
  const canvasBounds = useMemo(() => ({
    width: Math.max(2400, ...layout.items.map(item => (previewPositions.get(item.instanceId)?.x ?? item.x) + actualSize(item).width + 400)),
    height: Math.max(1600, ...layout.items.map(item => (previewPositions.get(item.instanceId)?.y ?? item.y) + actualSize(item).height + 400)),
  }), [layout.items, actualSize, previewPositions]);
  const itemSignature = layout.items.map(item => item.instanceId).join("\u001f");
  useEffect(() => {
    const live = new Set(layoutRef.current.items.map(item => item.instanceId));
    selectCards(selectedRef.current.filter(id => live.has(id)));
  }, [itemSignature]);
  useEffect(() => {
    const root = surface.current;
    if (!root || narrow || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      setMeasurements(previous => {
        const next = { ...previous }; let changed = false;
        for (const entry of entries) {
          const node = entry.target as HTMLElement, id = node.dataset.instanceId;
          if (!id) continue;
          const size = { width: node.offsetWidth, height: node.offsetHeight };
          if (next[id]?.width !== size.width || next[id]?.height !== size.height) { next[id] = size; changed = true; }
        }
        return changed ? next : previous;
      });
    });
    root.querySelectorAll<HTMLElement>("[data-instance-id]").forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [view, itemSignature, narrow]);

  function add(kind: SpaceComponentKind, position?: { x: number; y: number }) {
    if (!layoutReady || recoveringRef.current) return;
    const existing = layoutRef.current.items.find(item => item.kind === kind);
    if (existing) { remove(existing.instanceId); return; }
    const previous = layoutRef.current;
    const remembered = removedRef.current[kind];
    let next = toggleFromCanvas(previous, kind, remembered);
    const added = next.items.find(item => item.kind === kind);
    if (added && (position || !remembered)) {
      const bottom = previous.items.reduce((value, item) => Math.max(value, item.y + actualSize(item).height), 0);
      next = moveOnCanvas(next, added.instanceId, position?.x ?? CARD.margin, position?.y ?? (previous.items.length ? bottom + CARD.gap : CARD.margin));
    }
    persist(next);
  }
  function remove(instanceId: string) {
    if (!layoutReady || recoveringRef.current) return;
    const item = layoutRef.current.items.find(candidate => candidate.instanceId === instanceId);
    if (!item) return;
    removedRef.current = { ...removedRef.current, [item.kind]: item }; setRemoved(removedRef.current);
    persist(removeFromCanvas(layoutRef.current, instanceId));
  }
  function updateItem(itemId: string, update: (value: CanvasLayout, item: CanvasPlacement) => CanvasLayout) {
    const value = layoutRef.current, item = value.items.find(candidate => candidate.instanceId === itemId);
    if (item && layoutReady && !recoveringRef.current) {
      const next = update(value, item);
      if (JSON.stringify(value.items) !== JSON.stringify(next.items)) persist(next);
    }
  }
  function tidyLayout() {
    if (!layoutReady || narrow || recoveringRef.current) return;
    let y = CARD.margin;
    const next = { ...layoutRef.current, items: layoutRef.current.items.map(item => {
      const moved = { ...item, x: CARD.margin, y }; y += actualSize(item).height + CARD.gap; return moved;
    }) };
    persist(next);
  }
  function pointerDown(event: React.PointerEvent<HTMLElement>, item: CanvasPlacement) {
    // A fresh physical press must never inherit the previous long press's click fence.
    longPressClick.current = null;
    if (!layoutReady || recoveringRef.current || event.button !== 0 || !event.isPrimary || drag.current || selectionGesture.current || event.defaultPrevented || !(event.target instanceof Element)) return;
    if (annotatingRef.current) return; // 批注模式下组件不参与长按拖动，避免与画笔抢手势
    if (!canUseCanvasGesture(gestureRegion(event.target, event.currentTarget), "drag")) return;
    claimOuterGesture();
    const element = event.currentTarget, pointerId = event.pointerId;
    const group = !narrow && selectedRef.current.includes(item.instanceId)
      ? layoutRef.current.items.filter(value => selectedRef.current.includes(value.instanceId)) : [item];
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    drag.current = { id: item.instanceId, pointerId, target: element, startX: event.clientX, startY: event.clientY,
      scrollX: viewport.current?.scrollLeft ?? 0, scrollY: window.scrollY, items: group, moved: false, active: false, mobile: narrow };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      const active = drag.current;
      const selection = window.getSelection();
      if (!active || active.id !== item.instanceId || !element.isConnected || selection && !selection.isCollapsed) { endDrag(true); return; }
      try { element.setPointerCapture(pointerId); } catch { endDrag(true); return; }
      active.active = true;
      longPressClick.current = { cardId: item.instanceId, pointerId, until: Number.POSITIVE_INFINITY };
      dismissHint();
      dragPosition.current = { id: item.instanceId, items: group }; setDragPos(dragPosition.current);
    }, LONG_PRESS_MS);
  }
  function pointerMove(event: React.PointerEvent<HTMLElement>) {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    if (!active.active) {
      if (movedBeforeLongPress(event.clientX - active.startX, event.clientY - active.startY)) endDrag(true);
      return;
    }
    event.preventDefault();
    if (active.mobile) {
      const items = [...(dragOrderRef.current ?? layoutRef.current.items)];
      const moving = items.find(item => item.instanceId === active.id);
      if (!moving) return;
      const others = items.filter(item => item.instanceId !== active.id);
      const before = others.findIndex(item => {
        const node = surface.current?.querySelector<HTMLElement>(`[data-instance-id="${CSS.escape(item.instanceId)}"]`);
        const box = node?.getBoundingClientRect(); return box ? event.clientY < box.top + box.height / 2 : false;
      });
      others.splice(before < 0 ? others.length : before, 0, moving);
      if (others.some((item, index) => item.instanceId !== items[index]?.instanceId)) {
        active.moved = true; dragOrderRef.current = others; setDragOrder(others);
      }
      return;
    }
    const items = translateCanvasGroup(active.items,
      event.clientX - active.startX + (viewport.current?.scrollLeft ?? 0) - active.scrollX,
      event.clientY - active.startY + window.scrollY - active.scrollY);
    active.moved ||= items.some((item, index) => Math.abs(item.x - active.items[index]!.x) > 2 || Math.abs(item.y - active.items[index]!.y) > 2);
    dragPosition.current = { id: active.id, items }; setDragPos(dragPosition.current);
  }
  function endDrag(cancel = false) {
    if (pressTimer.current !== null) { window.clearTimeout(pressTimer.current); pressTimer.current = null; }
    const active = drag.current, position = dragPosition.current, order = dragOrderRef.current;
    if (active?.active) longPressClick.current = { cardId: active.id, pointerId: active.pointerId, until: Date.now() + 800 };
    drag.current = null; dragPosition.current = null; setDragPos(null);
    dragOrderRef.current = null; setDragOrder(null);
    if (active?.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    if (!cancel && active?.active && active.moved) {
      if (active.mobile && order) {
        // Keep the latest desktop size, scale and coordinates, changing only order.
        const latest = new Map(layoutRef.current.items.map(item => [item.instanceId, item]));
        persist({ ...layoutRef.current, items: order.flatMap(item => latest.has(item.instanceId) ? [latest.get(item.instanceId)!] : []) });
      }
      else if (position) {
        const positions = new Map(position.items.map(item => [item.instanceId, item]));
        // One layout update / CAS for the whole group; preserve newer sizes and all unselected cards.
        persist({ ...layoutRef.current, items: layoutRef.current.items.map(item => {
          const next = positions.get(item.instanceId); return next ? { ...item, x: next.x, y: next.y } : item;
        }) });
      }
    }
  }
  function selectCards(ids: readonly string[]) { selectedRef.current = ids; setSelectedIds(ids); }
  function claimOuterGesture() {
    window.dispatchEvent(new CustomEvent(SPACE_CANVAS_GESTURE_EVENT, { detail: { projectId, accountKey: detail.membership.userId, scope: "components" } }));
  }
  function startSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || narrow || !layoutReady || recoveringRef.current || event.button !== 0 || !event.isPrimary || event.defaultPrevented || drag.current || selectionGesture.current) return;
    if (annotatingRef.current) return; // 批注模式下空白处不圈选，避免与画笔抢手势
    longPressClick.current = null;
    claimOuterGesture();
    const element = event.currentTarget, pointerId = event.pointerId, box = element.getBoundingClientRect();
    selectionGesture.current = { pointerId, target: element, startX: event.clientX, startY: event.clientY,
      start: { x: event.clientX - box.left, y: event.clientY - box.top }, active: false };
    if (event.pointerType === "mouse") {
      // A desktop drag box must survive movement before the long-press delay.
      // Only bare canvas reaches here, so text/form selection remains untouched.
      event.preventDefault();
      try { element.setPointerCapture(pointerId); } catch { endSelection(true); return; }
      selectionGesture.current.active = true;
      marqueeRef.current = { rect: canvasSelectionRect(selectionGesture.current.start, selectionGesture.current.start), ids: [] };
      setMarquee(marqueeRef.current);
      return;
    }
    selectionTimer.current = window.setTimeout(() => {
      selectionTimer.current = null;
      const active = selectionGesture.current, textSelection = window.getSelection();
      if (!active || !element.isConnected || textSelection && !textSelection.isCollapsed) { endSelection(true); return; }
      try { element.setPointerCapture(pointerId); } catch { endSelection(true); return; }
      active.active = true;
      marqueeRef.current = { rect: canvasSelectionRect(active.start, active.start), ids: [] }; setMarquee(marqueeRef.current);
    }, LONG_PRESS_MS);
  }
  function moveSelection(event: React.PointerEvent<HTMLDivElement>) {
    const active = selectionGesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!active.active) {
      if (movedBeforeLongPress(event.clientX - active.startX, event.clientY - active.startY)) endSelection(true);
      return;
    }
    event.preventDefault();
    const box = active.target.getBoundingClientRect();
    const rect = canvasSelectionRect(active.start, { x: Math.max(0, event.clientX - box.left), y: Math.max(0, event.clientY - box.top) });
    const ids = intersectingCanvasItems(layoutRef.current.items.map(item => ({ instanceId: item.instanceId, x: item.x, y: item.y, ...actualSize(item) })), rect);
    marqueeRef.current = { rect, ids }; setMarquee(marqueeRef.current);
  }
  function endSelection(cancel = false) {
    if (selectionTimer.current !== null) { window.clearTimeout(selectionTimer.current); selectionTimer.current = null; }
    const active = selectionGesture.current, preview = marqueeRef.current;
    selectionGesture.current = null; marqueeRef.current = null; setMarquee(null);
    if (active?.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    if (active && !cancel) selectCards(active.active ? preview?.ids ?? [] : []);
  }
  useEffect(() => {
    const preventActiveDragScroll = (event: TouchEvent) => { if (drag.current?.active && event.cancelable) event.preventDefault(); };
    const cancel = () => { endDrag(true); endSelection(true); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (drag.current || selectionGesture.current || selectedRef.current.length)) {
        // Idle selection does not consume Escape from an editor or an open child dialog/menu.
        if (drag.current || selectionGesture.current) event.preventDefault();
        cancel(); selectCards([]);
      }
    };
    window.addEventListener("touchmove", preventActiveDragScroll, { passive: false });
    window.addEventListener("blur", cancel); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("touchmove", preventActiveDragScroll); window.removeEventListener("blur", cancel); window.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => {
    const innerGesture = (event: Event) => {
      const intent = (event as CustomEvent).detail;
      if (intent?.scope !== "flow" || intent.projectId !== projectId || intent.accountKey !== detail.membership.userId) return;
      endDrag(true); endSelection(true); selectCards([]);
    };
    window.addEventListener(SPACE_CANVAS_GESTURE_EVENT, innerGesture);
    return () => window.removeEventListener(SPACE_CANVAS_GESTURE_EVENT, innerGesture);
  }, [projectId, detail.membership.userId]);
  function moveFromMenu(itemId: string, x: number, y: number) {
    if (!layoutReady || recoveringRef.current) return;
    if (narrow) {
      const value = layoutRef.current, items = [...value.items], index = items.findIndex(item => item.instanceId === itemId);
      const target = Math.max(0, Math.min(items.length - 1, index + (y < 0 ? -1 : 1)));
      if (index < 0 || index === target) return;
      const [item] = items.splice(index, 1); items.splice(target, 0, item!); persist({ ...value, items });
    } else updateItem(itemId, (value, item) => moveOnCanvas(value, item.instanceId, item.x + x, item.y + y));
  }
  function scaleSelection(pointerItemId: string, factor: number) {
    if (!layoutReady || narrow || recoveringRef.current || drag.current || selectionGesture.current || !selectedRef.current.includes(pointerItemId)) return;
    const value = layoutRef.current;
    const selected = value.items.filter(item => selectedRef.current.includes(item.instanceId)).map(item => ({ ...item, scale: scaleOf(item) }));
    const result = scaleCanvasGroup(selected, factor, SCALE_MIN, SCALE_MAX);
    if (result.factor === 1) return;
    const scaled = new Map(result.items.map(item => [item.instanceId, item]));
    persist({ ...value, items: value.items.map(item => scaled.get(item.instanceId) ?? item) });
  }
  useEffect(() => {
    const node = surface.current;
    if (!node || narrow || !layoutReady) return;
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || drag.current?.active || selectionGesture.current?.active || recoveringRef.current || event.ctrlKey || event.metaKey || !(event.target instanceof Element)) return;
      const card = event.target.closest<HTMLElement>("[data-instance-id]");
      if (!card?.dataset.instanceId || !node.contains(card) || !selectedRef.current.includes(card.dataset.instanceId)) return;
      const focused = document.activeElement;
      const editorFocused = focused instanceof Element && card.contains(focused) && focused.matches(EDITOR_SELECTOR);
      const region = gestureRegion(event.target, card);
      // 编辑区是否还有可滚动内容：有则原生滚动优先，没有则允许缩放（文档卡默认编辑态且占满整卡）。
      const scrollable = region === "editor" && hasScrollableContent(event.target);
      if (!canUseCanvasGesture(region, "zoom", editorFocused, scrollable)) return;
      const { scaleDelta } = wheelScaleDelta({ deltaY: event.deltaY, shiftKey: event.shiftKey });
      if (!scaleDelta) return;
      event.preventDefault(); scaleSelection(card.dataset.instanceId, scaleDelta < 0 ? 1 / (1 - scaleDelta) : 1 + scaleDelta);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [narrow, view, layoutReady, persist]);

  const common = { detail, current: current.data, ...planningState };
  const bodyOf = (kind: SpaceComponentKind): ReactNode => {
    if (kind === "todos") return <SpaceTodosPanel {...common} onOpenNode={openNode}/>;
    if (kind === "overview") return <SpaceCollaborationOverview {...common} onOpenNode={openNode}/>;
    if (kind === "path") return <SpacePathCanvas detail={detail} reload={reload} presentation="canvas" onReady={readyStep}/>;
    if (kind === "teammates") return <SpaceTeammatesPanel {...common} onRefresh={refreshFacts}/>;
    if (kind === "documents") return <SpaceDocumentsPanel detail={detail}/>;
    if (kind === "deadline") return <SpaceResourcePanel current={current.data} {...planningState}/>;
    if (kind === "scope") return <SpaceScopeCutPanel {...common}/>;
    if (kind === "supervision") return <TeamSupervisionPanel projectId={projectId} accountKey={detail.membership.userId} archived={readOnly} onOpenAssistant={openAssistant}/>;
    return <div className={styles.assistantNote}><button type="button" data-canvas-longpress className={styles.button} onClick={openAssistant}>打开私人空间 AI</button></div>;
  };
  const available = availableKinds(layout);
  const interactive = layoutReady && !recovering;

  // —— 画布批注（用户要求）。全部只作用于本地批注状态，不碰布局与任何真实记录。——
  /** 事件坐标 → 画布坐标（画布自身有 translate/scale，必须用逆变换后取相对偏移）。 */
  function canvasPoint(event: { clientX: number; clientY: number }): CanvasPoint {
    const node = surface.current;
    if (!node) return { x: 0, y: 0 };
    const box = node.getBoundingClientRect();
    const scale = box.width > 0 ? node.offsetWidth / box.width : 1;
    return { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
  }
  function beginAnnotation(event: React.PointerEvent<HTMLElement>): boolean {
    if (!annotatingRef.current) return false;
    const tool = annotationToolRef.current;
    const point = canvasPoint(event);
    if (tool === "text") { setContextMenu(null); setNoteDraft({ canvasX: point.x, canvasY: point.y, text: "" }); return true; }
    if (tool === "eraser") {
      // 先擦便签再擦笔迹；只擦自己的批注，不触碰组件与真实数据。
      const note = noteAt(annotationRef.current, point);
      const next = note ? removeNotes(annotationRef.current, [note]) : eraseStrokes(annotationRef.current, strokesAt(annotationRef.current, point));
      if (next !== annotationRef.current) { annotationRef.current = next; setAnnotation(next); }
      return true;
    }
    const stroke: AnnotationStroke = { id: `a${Date.now().toString(36)}-${strokeSeq.current += 1}`, tool,
      color: toolColor(tool, ANNOTATION_COLORS[0]!), width: toolWidth(tool), points: [point] };
    drawing.current = { pointerId: event.pointerId, target: event.currentTarget as unknown as SVGSVGElement };
    setDraft(stroke);
    return true;
  }
  function moveAnnotation(event: React.PointerEvent<HTMLElement>) {
    const active = drawing.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = canvasPoint(event);
    setDraft(previous => previous ? { ...previous, points: appendPoint(previous.points, point) } : previous);
  }
  function endAnnotation(event: React.PointerEvent<HTMLElement>) {
    const active = drawing.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drawing.current = null;
    setDraft(previous => {
      // 单点笔画（只是点了一下）保留为一个小点，不静默丢弃用户的动作。
      if (previous) setAnnotation(current => addStroke(current, previous));
      return null;
    });
  }
  function commitNote() {
    setNoteDraft(previous => {
      if (previous) {
        const text = normalizeNoteText(previous.text);
        if (text) setAnnotation(current => addNote(current, { id: `n${Date.now().toString(36)}-${strokeSeq.current += 1}`, color: ANNOTATION_COLORS[0]!, x: previous.canvasX, y: previous.canvasY, text }));
      }
      return null;
    });
  }
  function pickTool(tool: AnnotationTool) { setAnnotationTool(tool); annotationToolRef.current = tool; setAnnotating(true); annotatingRef.current = true; setContextMenu(null); }
  /**
   * **取消批注 = 取消当前选中的工具**（用户 2026-10-13 明确）：
   * 只退出绘制状态、回到正常画布操作，**保留已经画好的笔迹**。
   * 想删掉笔迹请用「清空笔迹」——两者是不同的动作，不能混。
   */
  function cancelAnnotationTool() {
    setAnnotating(false); annotatingRef.current = false;
    setDraft(null); setNoteDraft(null); drawing.current = null; setContextMenu(null);
  }

  // —— 右击栏里的"针对团队空间定制"的办事工具。全部只调用既有能力，不新增状态。——
  /** 把画布视图恢复成可以看全的状态：缩放回 100%、回到左上、清掉圈选。 */
  function resetView() {
    const items = layoutRef.current.items;
    persist({ ...layoutRef.current, items: items.map(item => ({ ...item, scale: 1 })) });
    viewport.current?.scrollTo({ left: 0 });
    surface.current?.scrollIntoView({ block: "start" });
    selectCards([]);
    closeContextMenu();
  }
  function zoomTo100() {
    persist({ ...layoutRef.current, items: layoutRef.current.items.map(item => ({ ...item, scale: 1 })) });
    closeContextMenu();
  }
  /** 复制一份组件到它右边，方便同一个视图里对照两份（例如两份文档）。 */
  function duplicateItem(instanceId: string) {
    const source = layoutRef.current.items.find(item => item.instanceId === instanceId);
    if (!source) return;
    const spacing = CARD.width + CARD.gap;
    const occupied = layoutRef.current.items;
    let x = source.x + spacing;
    // 简单避让：若右侧已有组件，就继续右移，避免完全重叠看不出来。
    while (occupied.some(item => Math.abs(item.x - x) < CARD.width / 2 && Math.abs(item.y - source.y) < CARD.height / 2)) x += spacing;
    persist({ ...layoutRef.current, items: [...occupied, { ...source, instanceId: `${source.kind}-${Date.now().toString(36)}`, x, y: source.y }] });
    closeContextMenu();
  }
  /** 置顶：放到数组末尾（渲染顺序即层级），并留在原位置。 */
  function bringToFront(instanceId: string) {
    const items = [...layoutRef.current.items];
    const index = items.findIndex(item => item.instanceId === instanceId);
    if (index < 0) return;
    const [item] = items.splice(index, 1); items.push(item!);
    persist({ ...layoutRef.current, items });
    closeContextMenu();
  }
  function removeItem(instanceId: string) {
    const item = layoutRef.current.items.find(value => value.instanceId === instanceId);
    if (!item) return;
    setRemoved(previous => ({ ...previous, [item.kind]: item }));
    persist(removeFromCanvas(layoutRef.current, instanceId));
    closeContextMenu();
  }
  function closeContextMenu() { setContextMenu(null); }
  // 右击栏是固定定位的浮层：点空白处、按 Esc、滚动或改变窗口大小都应立即收起，
  // 否则它会一直挂在屏幕上挡住画布（用户 2026-10-13 明确要求点击空白处隐藏）。
  useEffect(() => {
    if (!contextMenu) return;
    const openedAt = Date.now();
    const dismiss = () => setContextMenu(null);
    /**
     * 点菜单**内部**绝不能收起菜单。
     *
     * 之前的写法用"打开后 200ms 内不收起"来绕开"右击自身也会派发 pointerdown"的问题，
     * 但那是错的：用户点菜单项时 pointerdown 先到，超过 200ms 就把菜单关掉了，
     * 随后的 click 永远不来 —— 表现正是用户报的"点一下没反应，而且菜单隐藏了"。
     * 正确做法是按**事件目标**判断（菜单内就不收），而不是按时间。
     */
    const press = (event: PointerEvent) => {
      const node = contextMenuRef.current;
      const target = event.target;
      if (node && target instanceof Node && node.contains(target)) return;
      // 仍要跳过"打开菜单的那一次右击"：它的 pointerdown 早于菜单渲染，落在这里时只差几毫秒。
      if (Date.now() - openedAt < 150) return;
      setContextMenu(null);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setContextMenu(null); };
    const media = window.matchMedia("(max-width: 760px)");
    // 注意：不要监听 scroll —— 菜单自己列表变长时也可能滚动，会把自己关掉。
    // 只保留"改变窗口大小"这种确实会让固定定位失效的情况。
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", dismiss);
    media.addEventListener("change", dismiss);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", dismiss);
      media.removeEventListener("change", dismiss);
    };
  }, [contextMenu]);
  // 「组件」栏点空白处收起。与右击栏分开处理：右击画布时先关掉组件栏、再弹菜单，顺序明确。
  useEffect(() => {
    if (!paletteOpen) return;
    const press = (event: PointerEvent) => {
      // 只认左键：右击会先派发 pointerdown(button=2)，不加判断的话
      // "右击画布 → 打开批注工具"这一步就会把组件栏关掉，用户会觉得"点工具时侧栏自己隐藏了"。
      if (event.button !== 0) return;
      const node = paletteRef.current;
      const target = event.target;
      if (node && target instanceof Node && node.contains(target)) return;
      setPaletteOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setPaletteOpen(false); };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", press, true); document.removeEventListener("keydown", key); };
  }, [paletteOpen]);
  /** 组件上的右击项：置顶、折叠/展开、复制一份、移除。全部走既有布局函数。 */
  function contextItemActions(instanceId: string) {
    const item = layoutRef.current.items.find(value => value.instanceId === instanceId);
    if (!item) return null;
    return <div className={styles.contextGrid}>
      <button type="button" role="menuitem" className={styles.contextItem} onClick={() => bringToFront(instanceId)}>置顶</button>
      <button type="button" role="menuitem" className={styles.contextItem} onClick={() => { updateItem(instanceId, (value, live) => toggleCanvasCollapsed(value, live.instanceId)); closeContextMenu(); }}>{item.collapsed ? "展开" : "折叠"}</button>
      <button type="button" role="menuitem" className={styles.contextItem} onClick={() => duplicateItem(instanceId)}>复制一份</button>
      <button type="button" role="menuitem" className={styles.contextItem} onClick={() => removeItem(instanceId)}>移除</button>
    </div>;
  }


  function showItem(item?: CanvasPlacement) {
    const first = item ?? layoutRef.current.items[0];
    if (!first) { viewport.current?.scrollTo({ left: 0 }); surface.current?.scrollIntoView({ block: "start" }); return; }
    const node = surface.current?.querySelector<HTMLElement>(`[data-instance-id="${CSS.escape(first.instanceId)}"]`);
    if (!node) return;
    if (!narrow) viewport.current?.scrollTo({ left: Math.max(0, first.x - 24) });
    const top = node.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, top - 140) });
  }
  function showTeammates() {
    if (view !== "canvas") { document.getElementById("space-teammates")?.scrollIntoView({ block: "start" }); return; }
    let item = layoutRef.current.items.find(value => value.kind === "teammates");
    if (!item) { const next = toggleFromCanvas(layoutRef.current, "teammates"); persist(next); item = next.items.find(value => value.kind === "teammates"); }
    else if (item.collapsed) persist(toggleCanvasCollapsed(layoutRef.current, item.instanceId));
    window.requestAnimationFrame(() => showItem(item));
  }
  function placementOptions(item: CanvasPlacement): ReactNode {
    const selected = selectedIds.includes(item.instanceId), singleSelected = selected && selectedIds.length === 1;
    return <div className={styles.menuBody} data-canvas-options>
      <button type="button" className={styles.secondary} onClick={() => showItem(item)}>查看组件</button>
      <button type="button" className={styles.secondary} disabled={!interactive} onClick={() => updateItem(item.instanceId, (value, live) => toggleCanvasCollapsed(value, live.instanceId))}>{item.collapsed ? "展开" : "折叠"}</button>
      <div className={styles.actions}>
        {!narrow && <><button type="button" className={styles.secondary} disabled={!interactive} onClick={() => moveFromMenu(item.instanceId, -24, 0)}>向左移动</button><button type="button" className={styles.secondary} disabled={!interactive} onClick={() => moveFromMenu(item.instanceId, 24, 0)}>向右移动</button></>}
        <button type="button" className={styles.secondary} disabled={!interactive} onClick={() => moveFromMenu(item.instanceId, 0, -24)}>{narrow ? "往前排" : "向上移动"}</button>
        <button type="button" className={styles.secondary} disabled={!interactive} onClick={() => moveFromMenu(item.instanceId, 0, 24)}>{narrow ? "往后排" : "向下移动"}</button>
      </div>
      {!narrow && <><p className={styles.muted}>{item.kind !== "path" && `宽 ${widthOf(item)} · `}{Math.round(scaleOf(item) * 100)}%</p><div className={styles.actions}>
        {item.kind !== "path" && <><button type="button" className={styles.secondary} disabled={!interactive || !singleSelected} title="只圈选一个组件后可调整宽度" onClick={() => updateItem(item.instanceId, (value, live) => resizeOnCanvas(value, live.instanceId, widthOf(live) - 48, heightOf(live)))}>窄一点</button>
        <button type="button" className={styles.secondary} disabled={!interactive || !singleSelected} title="只圈选一个组件后可调整宽度" onClick={() => updateItem(item.instanceId, (value, live) => resizeOnCanvas(value, live.instanceId, widthOf(live) + 48, heightOf(live)))}>宽一点</button></>}
        <button type="button" className={styles.secondary} disabled={!interactive || !selected} onClick={() => scaleSelection(item.instanceId, 1 / 1.1)}>缩小选中项</button>
        <button type="button" className={styles.secondary} disabled={!interactive || !selected} onClick={() => scaleSelection(item.instanceId, 1.1)}>放大选中项</button>
        <button type="button" className={styles.secondary} disabled={!interactive || !selected} title="以此组件恢复100%为目标，按相同比例缩放整组；受全组大小范围限制" onClick={() => scaleSelection(item.instanceId, 1 / scaleOf(layoutRef.current.items.find(value => value.instanceId === item.instanceId) ?? item))}>恢复100%</button>
      </div><p className={styles.muted}>{selected ? "缩放和恢复100%保持整组比例；单独圈选可调宽度。" : "先在空白处按住左键拖框圈选，再缩放。"}</p></>}
      <button type="button" className={styles.secondary} disabled={!interactive} title="只收回组件，内容保留，可重新添加" onClick={() => remove(item.instanceId)}>从我的画布移除</button>
    </div>;
  }

  return <div className={styles.root}>
    <header className={styles.header}>
      <div className={styles.identity}>
        <Link className={styles.back} href="/app">← 我的参赛</Link>
        <h1>{detail.project.name}</h1>
        {readOnly && <span className={styles.meta}>已归档，只读</span>}
      </div>
      <div className={styles.headerActions}>
        <SpaceInvitationTrigger detail={detail} onChanged={reload}/>
        <button type="button" className={styles.textButton} onClick={showTeammates}>队友 {detail.members.filter(member => member.status === "active").length}</button>
        <SpaceAssistantFloat detail={detail} inline onShared={() => void refreshFacts()}/>
        {view === "canvas" && !narrow && <button type="button" className={styles.textButton} onClick={() => showItem()}>回到内容</button>}
        <details className={styles.cardMenu}><summary aria-label="空间更多操作">⋯</summary><div className={styles.menuBody} data-canvas-options>
          <button type="button" className={styles.secondary} disabled={refreshing || current.loading} onClick={() => void refreshFacts()}>{refreshing ? "刷新中…" : "刷新"}</button>
          <button type="button" className={styles.secondary} aria-pressed={view === "canvas"} onClick={() => setViewPreference(view === "canvas" ? "collaboration" : "canvas")}>{view === "canvas" ? "阅读模式" : "自由画布"}</button>
          {view === "canvas" && !narrow && <button type="button" className={styles.secondary} disabled={!interactive} onClick={tidyLayout}>整理成单列</button>}
        </div></details>
        {(saving || dirty || recovering) && <span className={styles.saveState} role="status">{recovering ? "核对中…" : saving ? "保存中…" : "未确认保存"}</span>}
      </div>
    </header>
    {planningState.planningError && <p className={styles.error} role="alert">任务与时间信息更新失败，当前状态待核对。{planningState.planningError}{current.loading ? " 正在重试…" : " 请通过空间更多操作重试刷新。"}</p>}
    {membersError && <p className={styles.error} role="alert">成员更新失败，当前人员列表待核对。{membersError}</p>}
    <SpaceChanges projectId={projectId} currentUserId={detail.membership.userId} readOnly={readOnly}/>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {error && <div role="alert" className={styles.error}><p>{error}</p>{conflict && <div className={styles.actions}>
      <button type="button" className={styles.secondary} disabled={saving || recovering} onClick={() => void checkAndRetrySave()}>检查保存状态，再重试</button>
      <button type="button" className={styles.secondary} disabled={saving || recovering} onClick={() => void readSavedLayout()}>放弃本次调整，读取已保存摆放</button>
    </div>}</div>}

    {view === "collaboration" ? <div className={styles.collaboration}>
      <div className={styles.workGrid}><SpaceTodosPanel {...common} onOpenNode={openNode}/><SpaceCollaborationOverview {...common} onOpenNode={openNode}/></div>
      <section className={styles.flowSection}><SpacePathCanvas detail={detail} reload={reload} presentation="steps" onReady={readyStep}/></section>
      <SpaceTeammatesPanel {...common} onRefresh={refreshFacts}/>
      <TeamSupervisionPanel projectId={projectId} accountKey={detail.membership.userId} archived={readOnly} onOpenAssistant={openAssistant}/>
      <SpaceDocumentsPanel detail={detail}/>
      <details className={styles.assistance}><summary>查看倒计时与时间依据</summary><SpaceResourcePanel current={current.data} {...planningState}/></details>
      <details className={styles.assistance}><summary>做不完时，调整本次范围</summary><SpaceScopeCutPanel {...common}/></details>
    </div> : <>
      <div className={styles.canvasToolbar}>
        {/* open 完全由 React 控制，**不要**再挂 onToggle：
            React 把 open 设为 true 时浏览器也会派发一次 toggle，那时 currentTarget.open 仍是旧值 false，
            挂 onToggle 会立刻把状态设回 false —— 表现就是"组件栏一打开就自己关掉"。
            摘要点击只切换开合；收起统一由"点空白处"的监听处理。
            键盘用户按 Enter 也能打开，且不会被立刻收掉。 */}
        <details className={styles.palette} open={paletteOpen} ref={paletteRef}>
          <summary onClick={event => { event.preventDefault(); setPaletteOpen(value => !value); }}>组件</summary>
          <ul className={styles.paletteList}>{SPACE_COMPONENT_KINDS.map(kind => <li key={kind}><button type="button" className={styles.paletteItem} disabled={!interactive}
            aria-pressed={!available.includes(kind)} title={COMPONENT_HINTS[kind]} draggable={interactive && !narrow && available.includes(kind)} onDragStart={event => { event.dataTransfer.setData("text/plain", kind); event.dataTransfer.effectAllowed = "copy"; }} onClick={() => add(kind)}>
            <strong>{COMPONENT_LABELS[kind]}{!available.includes(kind) && " ✓"}</strong>
          </button>{layout.items.filter(item => item.kind === kind).map(item => <details key={item.instanceId} className={styles.palettePosition}><summary aria-label={`调整${COMPONENT_LABELS[kind]}摆放`}>⋯</summary>{placementOptions(item)}</details>)}</li>)}</ul>
        </details>
        {hintVisible && <button type="button" className={styles.hint} onClick={dismissHint} aria-label="知道了，关闭画布操作提示">{narrow ? "长按组件周围空白调整顺序；也可用 ⋯ 菜单。" : "空白处左键按住拖框圈选；选中后滚轮缩放、长按一起移动。"} ×</button>}
        {!narrow && selectedIds.length > 0 && <span className={styles.saveState}>已圈选 {selectedIds.length} 个 · 在选中项上滚轮缩放、长按一起移动；空白短点或 Esc 取消</span>}
      </div>
      {remote.loading && !layoutReady && <p role="status" className={styles.muted}>正在读取你保存的画布摆放…</p>}
      {remote.error && !layoutReady && <p role="alert" className={styles.error}>摆放读取失败，尚未允许修改。<button type="button" className={styles.secondary} onClick={() => void remote.reload()}>重新读取</button></p>}
      <div ref={viewport} className={styles.canvasViewport}><div ref={surface} className={styles.canvas} data-mobile={narrow} data-selecting={!!marquee} data-annotating={annotating} style={narrow ? undefined : { width: canvasBounds.width, minHeight: canvasBounds.height }}
        onPointerDown={event => { if (annotatingRef.current) { beginAnnotation(event); return; } startSelection(event); }}
        onPointerMove={event => { if (drawing.current?.pointerId === event.pointerId) { moveAnnotation(event); return; } moveSelection(event); }}
        onPointerUp={event => { if (drawing.current?.pointerId === event.pointerId) { endAnnotation(event); return; } if (selectionGesture.current?.pointerId === event.pointerId) endSelection(); }}
        onPointerCancel={event => { if (drawing.current?.pointerId === event.pointerId) { endAnnotation(event); return; } if (selectionGesture.current?.pointerId === event.pointerId) endSelection(true); }}
        onLostPointerCapture={event => { if (event.target === event.currentTarget && selectionGesture.current?.pointerId === event.pointerId) endSelection(true); }}
        onPointerLeave={() => { if (selectionGesture.current && !selectionGesture.current.active) endSelection(true); }}
        onContextMenu={event => {
          if (selectionGesture.current?.active) { event.preventDefault(); return; }
          if (readOnly) return;
          // 右击弹出快捷栏：空白处与组件上的菜单项不同，见下方渲染。
          event.preventDefault();
          const point = canvasPoint(event);
          const node = (event.target instanceof Element ? event.target.closest("[data-instance-id]") : null) as HTMLElement | null;
          setContextMenu({ x: event.clientX, y: event.clientY, instanceId: node?.dataset.instanceId ?? null, canvasX: point.x, canvasY: point.y });
        }}
        onDragOver={event => { if (!narrow) event.preventDefault(); }} onDrop={event => {
          if (narrow) return;
          event.preventDefault(); const kind = event.dataTransfer.getData("text/plain");
          if (!(SPACE_COMPONENT_KINDS as readonly string[]).includes(kind)) return;
          const box = event.currentTarget.getBoundingClientRect(); add(kind as SpaceComponentKind, { x: Math.max(0, event.clientX - box.left), y: Math.max(0, event.clientY - box.top) });
        }}>
        {layoutReady && layout.items.length === 0 && <p className={styles.empty}>从「组件」添加。</p>}
        {layoutReady && layout.items.map(item => {
          const position = previewPositions.get(item.instanceId) ?? item;
          const isDragging = previewPositions.has(item.instanceId);
          return <section key={item.instanceId} aria-label={COMPONENT_LABELS[item.kind]} data-instance-id={item.instanceId} data-component-kind={item.kind} data-collapsed={item.collapsed} data-dragging={isDragging} data-selected={!narrow && (marquee?.ids ?? selectedIds).includes(item.instanceId)} className={`${styles.card}${item.kind === "path" ? ` ${styles.pathCard}` : ""}`}
            style={narrow ? dragOrder ? { order: dragOrder.findIndex(value => value.instanceId === item.instanceId) } : undefined : { transform: `translate(${position.x}px, ${position.y}px) scale(${scaleOf(item)})`, transformOrigin: "0 0", width: item.kind === "path" ? "max-content" : widthOf(item) }}
            onPointerDown={event => pointerDown(event, item)} onPointerMove={pointerMove}
            onClickCapture={event => {
              const pointerId = "pointerId" in event.nativeEvent ? (event.nativeEvent as PointerEvent).pointerId : undefined;
              if (isLongPressClick(longPressClick.current, { cardId: item.instanceId, pointerId, detail: event.detail, now: Date.now() })) {
                longPressClick.current = null; event.preventDefault(); event.stopPropagation();
              }
            }}
            onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) endDrag(); }} onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) endDrag(true); }}
            onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) endDrag(true); }} onPointerLeave={() => { if (drag.current?.id === item.instanceId && !drag.current.active) endDrag(true); }}
            onContextMenu={event => { if (drag.current?.active || readOnly) { if (drag.current?.active) event.preventDefault(); return; } event.preventDefault(); event.stopPropagation();
              const point = canvasPoint(event);
              setContextMenu({ x: event.clientX, y: event.clientY, instanceId: item.instanceId, canvasX: point.x, canvasY: point.y }); }}>
            {(item.kind !== "documents" || item.collapsed) && <div className={styles.cardHead}>
              {item.collapsed && <span className={styles.cardTitle}>{COMPONENT_LABELS[item.kind]}</span>}
              {item.collapsed && <button type="button" data-canvas-longpress className={styles.textButton} disabled={!interactive} aria-label={`展开${COMPONENT_LABELS[item.kind]}`} aria-expanded={false} onClick={() => updateItem(item.instanceId, (value, live) => toggleCanvasCollapsed(value, live.instanceId))}>＋</button>}
              <details className={styles.cardMenu}><summary aria-label={`${COMPONENT_LABELS[item.kind]}操作`}>⋯</summary>{placementOptions(item)}</details>
            </div>}
            {!item.collapsed && <div className={styles.cardBody}>{bodyOf(item.kind)}</div>}
            <span className={styles.gestureHint} aria-hidden="true">{isDragging ? "松开完成 · Esc 取消" : narrow ? "长按周围空白调整顺序" : selectedIds.includes(item.instanceId) ? "滚轮缩放选中组 · 长按一起移动" : "长按移动 · 先圈选再缩放"}</span>
          </section>;
        })}
        {marquee && <div className={styles.marquee} data-canvas-marquee aria-hidden="true" style={{ left: marquee.rect.x, top: marquee.rect.y, width: Math.max(1, marquee.rect.width), height: Math.max(1, marquee.rect.height) }}/>}
        {/* 批注层：与组件用同一套坐标（surface 的 padding + 绝对定位），所以缩放画布时笔迹始终对齐。
            只有打开画笔时才接管指针，平时完全不拦点击。 */}
        {(hasAnnotations(annotation) || draft) && <svg className={styles.annotationLayer} width="100%" height="100%" aria-hidden="true" data-annotating={annotating}
          data-strokes={annotation.strokes.length} data-notes={annotation.notes.length} data-tool={annotationTool} data-drawing={drawing.current ? "1" : "0"}>
          {[...annotation.strokes, ...(draft ? [draft] : [])].map(item => item.tool === "arrow"
            ? <ArrowShape key={item.id} stroke={item}/>
            : <polyline key={item.id} points={item.points.map(point => `${point.x},${point.y}`).join(" ")} fill="none" stroke={item.color} strokeWidth={item.width} strokeLinecap="round" strokeLinejoin="round" opacity={item.tool === "highlighter" ? 0.45 : 1}/>)}
          {annotation.notes.map(note => <g key={note.id}>
            <rect x={note.x - 90} y={note.y - 26} width={180} height={52} rx="6" fill="var(--surface)" stroke={note.color} strokeWidth="1.5"/>
            <foreignObject x={note.x - 86} y={note.y - 22} width={172} height={44}>
              <div className={styles.annotationNote}>{note.text}</div>
            </foreignObject>
          </g>)}
        </svg>}
        {/* 文字便签输入：点一下就地写一句协作提示，例如「这里还缺检查条件」。 */}
        {noteDraft && <div className={styles.noteEditor} style={{ left: noteDraft.canvasX - 90, top: noteDraft.canvasY - 26 }}
          onPointerDown={event => event.stopPropagation()}>
          <input autoFocus value={noteDraft.text} maxLength={200} aria-label="便签内容" placeholder="例如：这里还缺检查条件"
            onChange={event => setNoteDraft(previous => previous ? { ...previous, text: event.target.value } : previous)}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitNote(); } if (event.key === "Escape") { event.preventDefault(); setNoteDraft(null); } }}/>
          <button type="button" onClick={commitNote}>写上</button>
          <button type="button" onClick={() => setNoteDraft(null)}>取消</button>
        </div>}
      </div>
      {/* 右击快捷栏（用户要求）：空白处给画布与批注工具，组件上另加该组件的操作。 */}
      {contextMenu && <div className={styles.contextMenu} role="menu" aria-label="画布快捷操作" ref={contextMenuRef}
        style={(() => {
          // 菜单必须始终完整落在窗口内：窗口不够高时下半部分会物理点不到（实测 720 高的窗口底部到 858）。
          // 空间不足就向上翻转；同时限制最大高度，超出部分在菜单内部滚动。
          const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
          const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
          const margin = 12;
          const height = Math.min(contextMenuHeight || 560, viewportHeight - margin * 2);
          const roomBelow = viewportHeight - margin - contextMenu.y;
          const top = roomBelow >= height ? contextMenu.y : Math.max(margin, contextMenu.y - height);
          return { left: Math.max(margin, Math.min(contextMenu.x, viewportWidth - 252)),
            top: Math.min(top, viewportHeight - margin - height),
            maxHeight: viewportHeight - margin * 2 };
        })()}
        onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
        {contextMenu.instanceId ? <>
          <p className={styles.contextTitle}>{COMPONENT_LABELS[layout.items.find(item => item.instanceId === contextMenu.instanceId)?.kind ?? "todos"]}</p>
          {contextItemActions(contextMenu.instanceId)}
          <hr/>
        </> : <p className={styles.contextTitle}>画布</p>}
        <p className={styles.contextGroup}>加组件（放到你右击的位置）</p>
        <div className={styles.contextGrid}>{SPACE_COMPONENT_KINDS.map(kind => <button key={kind} type="button" role="menuitem" className={styles.contextItem}
          title={COMPONENT_HINTS[kind]} onClick={() => { add(kind, { x: contextMenu.canvasX, y: contextMenu.canvasY }); closeContextMenu(); }}>
          {COMPONENT_LABELS[kind]}{!available.includes(kind) && " ✓"}</button>)}</div>
        <hr/>
        <p className={styles.contextGroup}>批注（只你自己看得见，刷新即清）</p>
        <div className={styles.contextGrid}>{(["pen", "highlighter", "arrow", "text", "eraser"] as const).map(tool => <button key={tool} type="button" role="menuitem" className={styles.contextItem}
          aria-pressed={annotating && annotationTool === tool} title={TOOL_HINTS[tool]} onClick={() => pickTool(tool)}>{TOOL_LABELS[tool]}</button>)}
          <button type="button" role="menuitem" className={styles.contextItem} disabled={!hasAnnotations(annotation)} onClick={() => { setAnnotation(undoAnnotation(annotation)); closeContextMenu(); }}>撤销一笔</button>
          <button type="button" role="menuitem" className={styles.contextItem} disabled={!annotation.redo.length} onClick={() => { setAnnotation(redoAnnotation(annotation)); closeContextMenu(); }}>重做</button>
          <button type="button" role="menuitem" className={styles.contextItem} disabled={!hasAnnotations(annotation)} onClick={() => { setAnnotation(clearAnnotations()); closeContextMenu(); }}>清空笔迹</button>
        </div>
        <hr/>
        <p className={styles.contextGroup}>画布视图</p>
        <div className={styles.contextGrid}>
          <button type="button" role="menuitem" className={styles.contextItem} onClick={resetView}>重置视图</button>
          <button type="button" role="menuitem" className={styles.contextItem} onClick={zoomTo100}>缩放回 100%</button>
          <button type="button" role="menuitem" className={styles.contextItem} onClick={() => { tidyLayout(); closeContextMenu(); }}>整理布局</button>
          <button type="button" role="menuitem" className={styles.contextItem} disabled={!annotating} onClick={cancelAnnotationTool}>取消批注（取消选中的工具）</button>
          <button type="button" role="menuitem" className={styles.contextItem} disabled={!hasAnnotations(annotation)} onClick={() => { setAnnotation(clearAnnotations()); setContextMenu(null); }}>删除全部笔迹</button>
        </div>
      </div>}
      {/* 批注进行中的浮动工具条：随时能换工具或退出，不必再右击。 */}
      {annotating && <div className={styles.annotationBar} role="toolbar" aria-label="批注工具" onPointerDown={event => event.stopPropagation()}>
        <span className={styles.annotationBarHint}>{TOOL_HINTS[annotationTool]}</span>
        {(["pen", "highlighter", "arrow", "text", "eraser"] as const).map(tool => <button key={tool} type="button" aria-pressed={annotationTool === tool}
          onClick={() => pickTool(tool)}>{TOOL_LABELS[tool]}</button>)}
        <button type="button" disabled={!hasAnnotations(annotation)} onClick={() => setAnnotation(undoAnnotation(annotation))}>撤销</button>
        <button type="button" disabled={!annotation.redo.length} onClick={() => setAnnotation(redoAnnotation(annotation))}>重做</button>
        <button type="button" disabled={!hasAnnotations(annotation)} onClick={() => setAnnotation(clearAnnotations())}>清空</button>
        {/* 「取消批注」＝取消当前选中的工具（保留笔迹）；删除笔迹请用左边那个「清空」。
            这是两个不同的动作：前者只是不再画，后者才动内容。 */}
        <button type="button" className={styles.annotationCancel} onClick={cancelAnnotationTool}>取消批注（取消选中的工具）</button>
      </div>}
      </div>
      {/* The opener remains available even when the private canvas contains no path card. */}
      {layoutReady && !layout.items.some(item => item.kind === "path" && !item.collapsed) && <div className={styles.openerOnly}><SpacePathCanvas detail={detail} reload={reload} presentation="steps" onReady={readyStep}/></div>}
    </>}
  </div>;
}
