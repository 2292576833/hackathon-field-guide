"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useApi } from "./client-api.ts";
import type { CurrentPlanningView } from "../modules/planning/types.ts";
import type { ProjectOfficialTracksView } from "../modules/projects/index.ts";
import { MyAvailabilityPanel, OfficialTrackPanel, ProjectGoalForm, SpaceTaskSummary, type ProjectDetail } from "./projects-client.tsx";
import { RulesPanel } from "./discovery-client.tsx";
import { ProjectDiscoveryPanel } from "./project-discovery.tsx";
import { MemberIntentionsPanel } from "./assessment-client.tsx";
import { buildSpaceGuideTree, type SpaceGuideStepId } from "../modules/space-workflow/guide-tree.ts";
import { deriveSpaceStepState, findSpaceStepForNode } from "../modules/space-workflow/step-state.ts";
import type { ReadState, SpaceRules } from "../modules/space-workflow/model.ts";
import { buildSpaceFlowGraph, clampSpaceFlowScale, measureSpaceFlowNodes, mobileSpaceFlowNodes, moveSpaceFlowOrder, readSpaceFlowOrder, readSpaceFlowPositions, scaleSpaceFlowNodes, spaceFlowBounds, spaceFlowPaths, spaceFlowStorageKey, type FlowPosition, type SpaceFlowNode } from "../modules/space-workflow/graph-layout.ts";
import { LONG_PRESS_MS, SPACE_CANVAS_GESTURE_EVENT, canvasSelectionRect, intersectingCanvasItems, isLongPressClick, movedBeforeLongPress, pointInCanvas, scaleCanvasGroup, translateCanvasGroup, type CanvasPoint, type CanvasSelectionRect, type LongPressClickFence } from "../modules/space-workflow/canvas-gestures.ts";
import styles from "./space-canvas.module.css";

const NARROW_BREAKPOINT = 761;
const SUGGEST = "suggest";
type NodePoint = FlowPosition & { id: string };
type DragGesture = { id: string; pointerId: number; target: HTMLElement; startClientX: number; startClientY: number;
  offsetX: number; offsetY: number; start: CanvasPoint; items: readonly NodePoint[]; active: boolean; mobileOrder: string[] };
type SelectionGesture = { pointerId: number; target: HTMLElement; startClientX: number; startClientY: number; start: CanvasPoint; active: boolean };

function readState<T>(state: { data: T | null; loading: boolean; error: Error | null }): ReadState<T> {
  return state.error ? { status: "error", message: "读取失败" } : state.loading ? { status: "loading" } : state.data === null ? { status: "unread" } : { status: "ready", value: state.data };
}

/** Real actions are directly visible; each opens its own work and useful links.
 * Long press changes only private placement; short click and keyboard activation
 * retain the real editor/navigation. Phone ordering never overwrites desktop. */
export function SpacePathCanvas({ detail, reload, presentation = "canvas", onReady }: {
  detail: ProjectDetail;
  reload: () => Promise<void>;
  presentation?: "steps" | "canvas";
  onReady?: (openStep: (nodeId: string) => void) => void;
}) {
  const projectId = detail.project.id;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const current = useApi<CurrentPlanningView>(`${base}/plans/current`);
  const rules = useApi<SpaceRules>(`${base}/rules`, { timeoutMs: 15_000 });
  const tracks = useApi<ProjectOfficialTracksView>(`${base}/official-tracks`, { timeoutMs: 15_000 });
  const [openStep, setOpenStep] = useState<SpaceGuideStepId | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const section = useRef<HTMLElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const readonly = detail.project.stage === "archived";
  const tree = useMemo(() => buildSpaceGuideTree({ detail: detail as never, current: current.data, planningLoading: current.loading,
    planningError: current.error?.message ?? null, rules: readState(rules), tracks: readState(tracks) }),
    [detail, current.data, current.loading, current.error, rules.data, rules.loading, rules.error, tracks.data, tracks.loading, tracks.error]);
  const graph = useMemo(() => buildSpaceFlowGraph(tree.steps, { includeResources: false }), [tree.steps]);
  const nodeSignature = graph.nodes.map(node => node.id).join("|");
  const key = spaceFlowStorageKey(projectId, detail.membership.userId);
  const mobileKey = spaceFlowStorageKey(projectId, detail.membership.userId, true);
  const [positions, setPositions] = useState<Record<string, FlowPosition>>(() => readSpaceFlowPositions(graph.nodes, null));
  const positionsRef = useRef(positions);
  const [mobileOrder, setMobileOrder] = useState(() => readSpaceFlowOrder(graph.nodes, null));
  const mobileOrderRef = useRef(mobileOrder); mobileOrderRef.current = mobileOrder;
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [dragPos, setDragPos] = useState<readonly NodePoint[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const selectedRef = useRef<readonly string[]>([]);
  const selectionGesture = useRef<SelectionGesture | null>(null);
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [marquee, setMarquee] = useState<{ rect: CanvasSelectionRect; ids: readonly string[] } | null>(null);
  const marqueeRef = useRef<typeof marquee>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [phoneWidth, setPhoneWidth] = useState(320);
  const drag = useRef<DragGesture | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  const wheelFrame = useRef<number | null>(null);
  const wheelSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<readonly NodePoint[] | null>(null);
  const suppressedClick = useRef<LongPressClickFence | null>(null);
  const [preferenceError, setPreferenceError] = useState("");
  const markerId = `space-flow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    cancelGesture(false); endSelection(true); selectNodes([]);
    let raw: string | null = null, orderRaw: string | null = null;
    try { raw = window.localStorage.getItem(key); orderRaw = window.localStorage.getItem(mobileKey); } catch { /* optional private preferences */ }
    const restoredPositions = readSpaceFlowPositions(graph.nodes, raw);
    positionsRef.current = restoredPositions; setPositions(restoredPositions);
    const restored = readSpaceFlowOrder(graph.nodes, orderRaw);
    mobileOrderRef.current = restored; setMobileOrder(restored);
  }, [nodeSignature, key, mobileKey]);
  useEffect(() => {
    // On mobile, an initially wide graph can inflate innerWidth before hydration.
    // CSS media queries and the document viewport still report the device width.
    const media = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`);
    const measure = () => {
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      setNarrow(media.matches);
      setPhoneWidth(Math.max(180, Math.min(section.current?.clientWidth || viewportWidth - 24, viewportWidth - 24)));
    };
    measure(); window.addEventListener("resize", measure); media.addEventListener("change", measure);
    const observer = new ResizeObserver(measure); if (section.current) observer.observe(section.current);
    return () => { window.removeEventListener("resize", measure); media.removeEventListener("change", measure); observer.disconnect(); };
  }, []);
  useEffect(() => {
    const element = surface.current; if (!element || presentation !== "canvas") return;
    const measure = () => {
      const measured: Record<string, { width: number; height: number }> = {};
      element.querySelectorAll<HTMLElement>("[data-flow-node]").forEach(node => {
        const id = node.dataset.flowNode; if (id && node.offsetWidth && node.offsetHeight) measured[id] = { width: node.offsetWidth, height: node.offsetHeight };
      });
      setSizes(previous => JSON.stringify(previous) === JSON.stringify(measured) ? previous : measured);
    };
    const observer = new ResizeObserver(measure);
    element.querySelectorAll<HTMLElement>("[data-flow-node]").forEach(node => observer.observe(node));
    measure(); return () => observer.disconnect();
  }, [nodeSignature, narrow, phoneWidth, presentation]);
  useEffect(() => {
    const preventActiveTouchScroll = (event: TouchEvent) => { if (drag.current?.active && event.cancelable) event.preventDefault(); };
    document.addEventListener("touchmove", preventActiveTouchScroll, { passive: false });
    return () => { document.removeEventListener("touchmove", preventActiveTouchScroll); if (pressTimer.current !== null) clearTimeout(pressTimer.current); if (selectionTimer.current !== null) clearTimeout(selectionTimer.current); if (frame.current !== null) window.cancelAnimationFrame(frame.current); };
  }, []);
  useEffect(() => { cancelGesture(false); endSelection(true); selectNodes([]); }, [narrow, presentation]);
  useEffect(() => {
    const cancel = () => { cancelGesture(false); endSelection(true); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!drag.current && !selectionGesture.current && !selectedRef.current.length)) return;
      if (drag.current || selectionGesture.current) event.preventDefault();
      cancel(); selectNodes([]);
    };
    const outerGesture = (event: Event) => {
      const intent = (event as CustomEvent).detail;
      if (intent?.scope !== "components" || intent.projectId !== projectId || intent.accountKey !== detail.membership.userId) return;
      cancel(); selectNodes([]);
    };
    window.addEventListener("keydown", escape); window.addEventListener("blur", cancel);
    window.addEventListener(SPACE_CANVAS_GESTURE_EVENT, outerGesture);
    return () => { window.removeEventListener("keydown", escape); window.removeEventListener("blur", cancel); window.removeEventListener(SPACE_CANVAS_GESTURE_EVENT, outerGesture); };
  }, [narrow, projectId, detail.membership.userId]);

  const recommendedNode = tree.currentStepId === "enter" ? "goal"
    : tree.currentStepId === "rules" ? tree.steps[1]?.nodes.find(node => node.id === "requirements")?.fact.status === "recorded" ? "official-track" : "requirements"
    : tree.currentStepId === "planning" ? "applied-plan"
    : tree.currentStepId === "execution" ? "start-task"
    : tree.currentStepId === "submission" ? "code-runtime" : "retrospective";
  const openNode = useCallback((nodeId: string) => {
    const requestedId = nodeId === SUGGEST ? recommendedNode : nodeId;
    const step = findSpaceStepForNode(tree.steps, requestedId);
    if (!step) return;
    if (!dialog.current?.open) returnFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : section.current;
    setSelectedNodeId(step.nodes.some(node => node.id === requestedId) ? requestedId : step.nodes[0]?.id ?? null);
    setOpenStep(step.id);
  }, [tree.steps, recommendedNode]);
  const openNodeRef = useRef(openNode); openNodeRef.current = openNode;
  useEffect(() => { onReady?.(openNode); }, [onReady, openNode]);
  useEffect(() => {
    const revealGoal = () => { if (window.location.hash === "#project-goal") openNodeRef.current("goal"); };
    revealGoal(); window.addEventListener("hashchange", revealGoal);
    return () => window.removeEventListener("hashchange", revealGoal);
  }, [projectId]);
  useEffect(() => {
    if (!dialog.current) return;
    if (openStep && !dialog.current.open) dialog.current.showModal();
    else if (!openStep && dialog.current.open) dialog.current.close();
  }, [openStep]);
  function restoreFocus() {
    setOpenStep(null);
    const target = returnFocus.current; returnFocus.current = null;
    // Another dialog (such as invitations) can replace this guide. Never steal
    // its focus or focus the entire multi-screen graph as a fallback.
    if (document.querySelector("dialog[open]")) return;
    if (target?.isConnected) target.focus({ preventScroll: true });
    else surface.current?.querySelector<HTMLButtonElement>("[data-graph-node] > button")?.focus({ preventScroll: true });
  }
  function leaveForLink(event: React.MouseEvent<HTMLDivElement>) {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.target === "_blank") return;
    const destination = new URL(link.href);
    if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.hash === "#project-goal") {
      event.preventDefault(); openNode("goal"); return;
    }
    if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.hash === "#space-invitation") {
      returnFocus.current = null;
      dialog.current?.close(); setOpenStep(null);
    }
  }
  const refreshFacts = useCallback(async () => { await reload(); await Promise.all([current.reload(), rules.reload(), tracks.reload()]); }, [reload, current.reload, rules.reload, tracks.reload]);
  function savePositions(next: Record<string, FlowPosition>) {
    try { window.localStorage.setItem(key, JSON.stringify(Object.entries(next).map(([id, point]) => ({ id, ...point })))); setPreferenceError(""); }
    catch { setPreferenceError("本次节点调整仅保留在屏幕上，浏览器未能保存。请允许本站本地存储后再调整。"); }
  }
  function saveOrder(next: string[]) {
    try { window.localStorage.setItem(mobileKey, JSON.stringify(next)); setPreferenceError(""); }
    catch { setPreferenceError("本次手机排序仅保留在屏幕上，浏览器未能保存。请允许本站本地存储后再调整。"); }
  }
  function changeScale(id: string, delta: number) {
    if (narrow || drag.current || selectionGesture.current || !selectedRef.current.includes(id)) return;
    const selected = graph.nodes.filter(node => selectedRef.current.includes(node.id)).map(node => {
      const point = positionsRef.current[node.id] ?? node;
      return { id: node.id, x: point.x, y: point.y, scale: clampSpaceFlowScale(point.scale ?? 1) };
    });
    const result = scaleCanvasGroup(selected, delta < 0 ? 1 / (1 - delta) : 1 + delta);
    if (result.factor === 1) return;
    const next = { ...positionsRef.current };
    for (const point of result.items) next[point.id] = { x: point.x, y: point.y, scale: point.scale };
    positionsRef.current = next;
    if (wheelFrame.current === null) wheelFrame.current = window.requestAnimationFrame(() => { wheelFrame.current = null; setPositions(positionsRef.current); });
    if (wheelSaveTimer.current !== null) clearTimeout(wheelSaveTimer.current);
    wheelSaveTimer.current = setTimeout(() => { wheelSaveTimer.current = null; savePositions(positionsRef.current); }, 180);
  }

  useEffect(() => {
    const element = surface.current; if (!element || presentation !== "canvas" || narrow) return;
    const zoomNode = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-graph-node]") : null;
      const id = target?.dataset.graphNode;
      if (!id || !element.contains(target) || !selectedRef.current.includes(id) || event.deltaY === 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || drag.current || selectionGesture.current) return;
      if (event.target instanceof Element && event.target.closest("input,select,textarea,[contenteditable=true],[data-flow-options]")) return;
      event.preventDefault(); event.stopPropagation();
      changeScale(id, event.deltaY < 0 ? 0.05 : -0.05);
    };
    element.addEventListener("wheel", zoomNode, { passive: false });
    return () => {
      element.removeEventListener("wheel", zoomNode);
      if (wheelFrame.current !== null) { window.cancelAnimationFrame(wheelFrame.current); wheelFrame.current = null; }
      if (wheelSaveTimer.current !== null) { clearTimeout(wheelSaveTimer.current); wheelSaveTimer.current = null; try { window.localStorage.setItem(key, JSON.stringify(Object.entries(positionsRef.current).map(([id, point]) => ({ id, ...point })))); } catch { /* No state update during unmount. */ } }
    };
  }, [narrow, key, nodeSignature, presentation]);

  const measuredNodes = measureSpaceFlowNodes(graph.nodes, sizes);
  const placedNodes = narrow ? mobileSpaceFlowNodes(measuredNodes, mobileOrder, phoneWidth) : scaleSpaceFlowNodes(measuredNodes.map(node => ({ ...node, ...positions[node.id] })));
  const dragPositions = new Map(dragPos?.map(point => [point.id, point]) ?? []);
  const previewNodes = placedNodes.map(node => { const point = dragPositions.get(node.id); return point ? { ...node, x: point.x, y: point.y } : node; });
  const bounds = narrow ? { width: phoneWidth, height: spaceFlowBounds(previewNodes, 0).height + 16 } : spaceFlowBounds(previewNodes);
  const paths = spaceFlowPaths(previewNodes, graph.edges, narrow);

  function pointerDown(event: React.PointerEvent<HTMLElement>, node: SpaceFlowNode) {
    event.stopPropagation();
    suppressedClick.current = null;
    if (presentation !== "canvas" || event.button !== 0 || !event.isPrimary || event.defaultPrevented || drag.current || selectionGesture.current) return;
    const element = surface.current, box = element?.getBoundingClientRect(); if (!element || !box) return;
    claimInnerGesture();
    const scaleX = box.width / element.offsetWidth || 1, scaleY = box.height / element.offsetHeight || 1;
    const start = pointInCanvas({ x: event.clientX, y: event.clientY }, { x: box.left, y: box.top }, scaleX, scaleY);
    const group = !narrow && selectedRef.current.includes(node.id) ? placedNodes.filter(item => selectedRef.current.includes(item.id)) : [node];
    // The surface remains mounted while phone reordering moves node elements.
    // Capturing on the node itself loses capture as React reorders its DOM.
    const gesture: DragGesture = { id: node.id, pointerId: event.pointerId, target: element,
      startClientX: event.clientX, startClientY: event.clientY, offsetX: (event.clientX - box.left) / scaleX - node.x,
      offsetY: (event.clientY - box.top) / scaleY - node.y, start, items: group.map(item => ({ id: item.id, x: item.x, y: item.y })), active: false, mobileOrder: [...mobileOrderRef.current] };
    drag.current = gesture;
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      if (drag.current !== gesture || !gesture.target.isConnected || window.getSelection()?.type === "Range") { if (drag.current === gesture) drag.current = null; return; }
      try { gesture.target.setPointerCapture(gesture.pointerId); } catch { drag.current = null; return; }
      gesture.active = true; setMenuId(null); setDragPos(gesture.items);
      suppressedClick.current = { cardId: node.id, pointerId: event.pointerId, until: Number.POSITIVE_INFINITY };
    }, LONG_PRESS_MS);
  }
  function pointerMove(event: React.PointerEvent<HTMLElement>) {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!active.active) {
      if (movedBeforeLongPress(event.clientX - active.startClientX, event.clientY - active.startClientY)) cancelGesture(false);
      return;
    }
    event.preventDefault();
    const element = surface.current, box = element?.getBoundingClientRect(); if (!element || !box) return;
    const scaleX = box.width / element.offsetWidth || 1, scaleY = box.height / element.offsetHeight || 1;
    const point = pointInCanvas({ x: event.clientX, y: event.clientY }, { x: box.left, y: box.top }, scaleX, scaleY);
    const moving = placedNodes.find(node => node.id === active.id); if (!moving) return;
    const x = narrow ? moving.x : Math.max(0, Math.round((event.clientX - box.left) / scaleX - active.offsetX));
    const y = Math.max(0, Math.round((event.clientY - box.top) / scaleY - active.offsetY));
    if (narrow) {
      const others = placedNodes.filter(node => node.id !== active.id);
      const index = others.filter(node => y + moving.height / 2 > node.y + node.height / 2).length;
      const next = moveSpaceFlowOrder(mobileOrderRef.current, active.id, index);
      mobileOrderRef.current = next; setMobileOrder(next);
    }
    pending.current = narrow ? [{ id: active.id, x, y }] : translateCanvasGroup(active.items, point.x - active.start.x, point.y - active.start.y);
    if (frame.current === null) frame.current = window.requestAnimationFrame(() => { frame.current = null; if (pending.current) setDragPos(pending.current); });
  }
  function cancelGesture(save: boolean) {
    if (pressTimer.current !== null) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    if (frame.current !== null) { window.cancelAnimationFrame(frame.current); frame.current = null; }
    const active = drag.current, position = pending.current;
    pending.current = null; drag.current = null; setDragPos(null);
    if (!active?.active) return;
    suppressedClick.current = { cardId: active.id, pointerId: active.pointerId, until: Date.now() + 800 };
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    if (narrow) {
      if (save) saveOrder(mobileOrderRef.current);
      else { mobileOrderRef.current = active.mobileOrder; setMobileOrder(active.mobileOrder); }
    } else if (save && position) {
      const next = { ...positionsRef.current };
      for (const point of position) next[point.id] = { ...next[point.id], x: point.x, y: point.y };
      positionsRef.current = next; setPositions(next); savePositions(next);
    }
  }
  function preventDragClick(event: React.MouseEvent<HTMLElement>, id: string): boolean {
    const pointerId = "pointerId" in event.nativeEvent ? (event.nativeEvent as PointerEvent).pointerId : undefined;
    if (isLongPressClick(suppressedClick.current, { cardId: id, pointerId, detail: event.detail, now: Date.now() })) {
      suppressedClick.current = null; event.preventDefault(); event.stopPropagation(); return true;
    }
    return false;
  }
  function selectNodes(ids: readonly string[]) { selectedRef.current = ids; setSelectedIds(ids); }
  function claimInnerGesture() {
    window.dispatchEvent(new CustomEvent(SPACE_CANVAS_GESTURE_EVENT, { detail: { projectId, accountKey: detail.membership.userId, scope: "flow" } }));
  }
  function startSelection(event: React.PointerEvent<HTMLDivElement>) {
    // Every pointer inside the graph belongs to this layer, including its empty space.
    event.stopPropagation();
    suppressedClick.current = null;
    if (event.target !== event.currentTarget || narrow || event.button !== 0 || !event.isPrimary || event.defaultPrevented || drag.current || selectionGesture.current) return;
    claimInnerGesture();
    const element = event.currentTarget, box = element.getBoundingClientRect();
    const start = pointInCanvas({ x: event.clientX, y: event.clientY }, { x: box.left, y: box.top }, box.width / element.offsetWidth || 1, box.height / element.offsetHeight || 1);
    const active: SelectionGesture = { pointerId: event.pointerId, target: element, startClientX: event.clientX, startClientY: event.clientY, start, active: false };
    selectionGesture.current = active;
    if (event.pointerType === "mouse") {
      event.preventDefault();
      try { element.setPointerCapture(active.pointerId); } catch { endSelection(true); return; }
      active.active = true; setMenuId(null);
      marqueeRef.current = { rect: canvasSelectionRect(start, start), ids: [] }; setMarquee(marqueeRef.current);
      return;
    }
    selectionTimer.current = setTimeout(() => {
      selectionTimer.current = null;
      if (selectionGesture.current !== active || !element.isConnected || window.getSelection()?.type === "Range") { endSelection(true); return; }
      try { element.setPointerCapture(active.pointerId); } catch { endSelection(true); return; }
      active.active = true; setMenuId(null);
      marqueeRef.current = { rect: canvasSelectionRect(start, start), ids: [] }; setMarquee(marqueeRef.current);
    }, LONG_PRESS_MS);
  }
  function moveSelection(event: React.PointerEvent<HTMLDivElement>) {
    const active = selectionGesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!active.active) {
      if (movedBeforeLongPress(event.clientX - active.startClientX, event.clientY - active.startClientY)) endSelection(true);
      return;
    }
    event.preventDefault();
    const element = active.target, box = element.getBoundingClientRect();
    const point = pointInCanvas({ x: event.clientX, y: event.clientY }, { x: box.left, y: box.top }, box.width / element.offsetWidth || 1, box.height / element.offsetHeight || 1);
    const rect = canvasSelectionRect(active.start, { x: Math.max(0, point.x), y: Math.max(0, point.y) });
    const ids = intersectingCanvasItems(placedNodes.map(node => ({ instanceId: node.id, x: node.x, y: node.y, width: node.width, height: node.height })), rect);
    marqueeRef.current = { rect, ids }; setMarquee(marqueeRef.current);
  }
  function endSelection(cancel = false) {
    if (selectionTimer.current !== null) { clearTimeout(selectionTimer.current); selectionTimer.current = null; }
    const active = selectionGesture.current, preview = marqueeRef.current;
    selectionGesture.current = null; marqueeRef.current = null; setMarquee(null);
    if (active?.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    if (active && !cancel) selectNodes(active.active ? preview?.ids ?? [] : []);
  }
  function moveNode(node: SpaceFlowNode, dx: number, dy: number) {
    if (narrow) {
      const next = moveSpaceFlowOrder(mobileOrderRef.current, node.id, mobileOrderRef.current.indexOf(node.id) + (dy > 0 ? 1 : -1));
      mobileOrderRef.current = next; setMobileOrder(next); saveOrder(next);
    } else {
      const point = positionsRef.current[node.id] ?? node, next = { ...positionsRef.current, [node.id]: { ...point, x: Math.max(0, point.x + dx), y: Math.max(0, point.y + dy) } };
      positionsRef.current = next; setPositions(next); savePositions(next);
    }
  }
  function keyboardMove(event: React.KeyboardEvent<HTMLElement>, node: SpaceFlowNode) {
    if (!event.altKey) return;
    if (!narrow && selectedRef.current.includes(node.id) && ["+", "=", "-", "_"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); changeScale(node.id, ["-", "_"].includes(event.key) ? -0.05 : 0.05); return; }
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] };
    const offset = offsets[event.key]; if (!offset || narrow && offset[0]) return;
    event.preventDefault(); event.stopPropagation(); moveNode(node, offset[0], offset[1]);
  }
  const activeStep = openStep ? tree.steps.find(step => step.id === openStep) ?? null : null;
  const activeNode = activeStep?.nodes.find(node => node.id === selectedNodeId) ?? activeStep?.nodes[0];
  const activeLinks = activeNode ? [...activeNode.links, ...activeNode.tools].filter((link, index, all) =>
    all.findIndex(item => item.href === link.href) === index && !(activeNode.id === "goal" && link.href.endsWith("#project-goal"))) : [];
  const suggestedAction = recommendedNode;

  function stepButton(step: typeof tree.steps[number], index: number) {
    const state = deriveSpaceStepState(step, tree.currentStepId);
    return <button type="button" className={styles.node} data-current={state.current} data-state={state.status} aria-current={state.current ? "step" : undefined} onClick={() => openNode(step.id)} title={`${step.title}：${step.summary}`}>
      <span className={styles.nodeNum}>第 {index + 1} 步</span><span className={styles.nodeLabel}>{step.title.replace(/^\d+\.\s*/, "")}</span><span className={styles.nodeState}>{state.label}</span>
    </button>;
  }
  function graphNode(node: SpaceFlowNode) {
    const action = tree.steps.find(step => step.id === node.stageId)?.nodes.find(item => item.id === node.actionId);
    const handlers = { onPointerDown: (event: React.PointerEvent<HTMLElement>) => pointerDown(event, node),
      onPointerLeave: () => { if (drag.current?.id === node.id && !drag.current.active) cancelGesture(false); },
      onContextMenu: (event: React.MouseEvent<HTMLElement>) => { if (drag.current?.active) event.preventDefault(); }, onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => keyboardMove(event, node) };
    const scale = node.scale ?? 1;
    const naturalWidth = narrow ? node.width : graph.nodes.find(item => item.id === node.id)!.width;
    return <div key={node.id} className={styles.flowFrame} data-flow-node={node.id} data-graph-node={node.id} data-dragging={dragPositions.has(node.id)} data-flow-selected={!narrow && (marquee?.ids ?? selectedIds).includes(node.id)} data-kind={node.kind} data-scale={scale} style={{ width: naturalWidth, transform: `translate(${node.x}px, ${node.y}px) scale(${scale})` }}>
      {node.kind === "action" ? <button type="button" className={styles.flowNode} data-state={action?.fact.status} data-current={node.actionId === suggestedAction} {...handlers} onClick={event => { if (!preventDragClick(event, node.id)) openNode(node.actionId); }} title={`${action?.title ?? node.title}；短按打开，长按移动；Alt 加方向键移动，圈选后 Alt 加正负号缩放整组`}>
        <strong>{node.title}</strong><span className={styles.flowStatus}>{action?.fact.label}{node.actionId === suggestedAction ? " · 建议先做" : ""}</span>
      </button> : <a className={`${styles.flowNode} ${styles.flowResource}`} href={node.href} draggable={false} {...handlers} onClick={event => { preventDragClick(event, node.id); }} title={`${node.purpose ?? node.title}；短按打开，长按移动`}><span>{node.title}</span><span aria-hidden="true" className={styles.resourceArrow}>↗</span></a>}
      <button type="button" className={styles.nodeMenuButton} data-flow-options aria-label={`调整${node.title}`} aria-expanded={menuId === node.id} onClick={() => setMenuId(value => value === node.id ? null : node.id)}>⋯</button>
      {menuId === node.id && <div className={styles.moveMenu} data-flow-options role="group" aria-label={`调整${node.title}`}>
        <button type="button" onClick={() => moveNode(node, 0, -24)} aria-label="向上移动">↑</button><button type="button" onClick={() => moveNode(node, 0, 24)} aria-label="向下移动">↓</button>
        {!narrow && <><button type="button" onClick={() => moveNode(node, -24, 0)} aria-label="向左移动">←</button><button type="button" onClick={() => moveNode(node, 24, 0)} aria-label="向右移动">→</button></>}
        {!narrow && <><button type="button" onClick={() => changeScale(node.id, -0.05)} aria-label="缩小选中节点" title="先圈选，再按相同比例缩小整组" disabled={!selectedIds.includes(node.id) || scale <= 0.5}>−</button><span>{Math.round(scale * 100)}%</span><button type="button" onClick={() => changeScale(node.id, 0.05)} aria-label="放大选中节点" title="先圈选，再按相同比例放大整组" disabled={!selectedIds.includes(node.id) || scale >= 2}>＋</button></>}
        <button type="button" onClick={() => setMenuId(null)}>完成</button>
      </div>}
    </div>;
  }

  return <section ref={section} tabIndex={-1} className={styles.canvasSection} aria-label="参赛流程主线" id="space-path-line" data-presentation={presentation} data-mobile={narrow} data-space-flow-width={bounds.width} data-space-flow-height={bounds.height} style={presentation === "canvas" ? { width: narrow ? "100%" : bounds.width } : undefined}>
    {readonly && presentation === "canvas" && <p className={styles.notice}>归档只读</p>}
    {preferenceError && <p role="status" className={styles.notice}>{preferenceError}</p>}
    {presentation === "steps" ? <>
      <div className={styles.head}><h2>参赛流程</h2><span className={styles.badge}>{readonly ? "归档只读" : "可以并行，按需打开"}</span></div>
      <button type="button" className={styles.next} onClick={() => openNode(SUGGEST)}><span className={styles.nodeNum}>建议先做</span><strong>{tree.next.title}</strong><span>{tree.next.purpose}</span></button>
      <ol className={styles.stack}>{tree.steps.map((step, index) => <li key={step.id}>{stepButton(step, index)}</li>)}</ol>
    </> : <><p className={styles.hint}>{narrow ? "短按打开行动，长按调整顺序。" : selectedIds.length ? `已圈选 ${selectedIds.length} 个行动 · 在选中项上滚轮缩放、长按一起移动；空白短点或 Esc 取消。` : "短按打开行动；空白处左键按住拖框圈选，选中后滚轮缩放、长按一起移动。"}</p>
    <div ref={surface} className={styles.graphSurface} data-space-flow-surface data-flow-selecting={!!marquee} style={{ width: bounds.width, height: bounds.height }}
      onPointerDown={startSelection} onPointerMove={event => { pointerMove(event); moveSelection(event); }}
      onPointerUp={event => { event.stopPropagation(); if (drag.current?.pointerId === event.pointerId) cancelGesture(true); if (selectionGesture.current?.pointerId === event.pointerId) endSelection(); }}
      onPointerCancel={event => { event.stopPropagation(); if (drag.current?.pointerId === event.pointerId) cancelGesture(false); if (selectionGesture.current?.pointerId === event.pointerId) endSelection(true); }}
      onLostPointerCapture={event => { event.stopPropagation(); if (drag.current?.pointerId === event.pointerId) cancelGesture(false); if (selectionGesture.current?.pointerId === event.pointerId) endSelection(true); }}
      onPointerLeave={() => { if (selectionGesture.current && !selectionGesture.current.active) endSelection(true); }}
      onContextMenu={event => { if (selectionGesture.current?.active || drag.current?.active) event.preventDefault(); }}
      onClickCapture={event => { if (suppressedClick.current) preventDragClick(event, suppressedClick.current.cardId); }}>
      <svg className={styles.svg} viewBox={`0 0 ${bounds.width} ${bounds.height}`} aria-hidden="true"><defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor"/></marker></defs>{paths.map(path => <path key={`${path.from}-${path.to}`} className={styles.edge} data-kind={path.kind} d={path.d} markerEnd={`url(#${markerId})`}/>)}</svg>
      {previewNodes.map(graphNode)}
      {marquee && <div className={styles.marquee} data-flow-marquee aria-hidden="true" style={{ left: marquee.rect.x, top: marquee.rect.y, width: Math.max(1, marquee.rect.width), height: Math.max(1, marquee.rect.height) }}/>}
    </div></>}

    <dialog ref={dialog} className={styles.dialog} aria-labelledby="space-path-dialog-title" onCancel={event => { event.preventDefault(); setOpenStep(null); }} onClose={restoreFocus}>
      {activeStep && <>
        <div className={styles.dialogHead}><div><h3 id="space-path-dialog-title">{presentation === "canvas" ? graph.nodes.find(node => node.kind === "action" && node.actionId === activeNode?.id)?.title ?? activeStep.title : activeStep.title}</h3>{presentation === "steps" && <p>{activeStep.summary}</p>}</div><button type="button" className={styles.closeButton} onClick={() => setOpenStep(null)}>关闭</button></div>
        <div className={styles.dialogBody} onClick={leaveForLink}>
          {readonly && <p className={styles.notice}>空间已归档，只能查看历史记录和说明。</p>}
          {presentation === "steps" && <div className={styles.actionTabs} aria-label="本步骤可做的事">{activeStep.nodes.map(node => <button key={node.id} type="button" className={styles.actionTab} aria-pressed={activeNode?.id === node.id} onClick={() => setSelectedNodeId(node.id)}>{node.title}</button>)}</div>}
          {activeNode && <div className={styles.guideDetail}>
            {presentation === "steps" && <h4>{activeNode.title}</h4>}<p className={styles.fact} data-state={activeNode.fact.status}>{activeNode.fact.label}：{activeNode.fact.explanation}</p>
            <p className={styles.hint}>{activeNode.when}</p><ol>{activeNode.actions.map(action => <li key={action}>{action}</li>)}</ol>
            <p><strong>怎样确认：</strong>{activeNode.condition}</p><p className={styles.hint}>下一步：{activeNode.next}</p>
          </div>}
          {activeNode?.id === "goal" && (readonly ? <p className={styles.hint}>目标：{detail.project.goal || "未记录"}；最小成果：{detail.project.minimumDeliverable || "未记录"}。</p> : <ProjectGoalForm detail={detail} reload={refreshFacts} expanded/>)}
          {activeNode?.id === "goal" && <div className={styles.resourceLinks}><a href={`/app/projects/${encodeURIComponent(projectId)}/plan`}>继续安排任务 →</a></div>}
          {activeNode?.id === "duties-time" && <><MemberIntentionsPanel detail={detail} onProjectChange={refreshFacts}/><MyAvailabilityPanel detail={detail} reload={refreshFacts}/></>}
          {activeNode?.id === "registration" && <ProjectDiscoveryPanel projectId={projectId} readonly={readonly || detail.membership.role !== "manager"}/>}
          {activeNode?.id === "official-track" && <OfficialTrackPanel detail={detail} onProjectChange={refreshFacts}/>}
          {activeNode?.id === "requirements" && <RulesPanel detail={detail}/>}
          {(activeNode?.id === "start-task" || activeNode?.id === "applied-plan") && <SpaceTaskSummary detail={detail}/>}
          {activeLinks.length > 0 && <div className={styles.resourceLinks}>{activeLinks.map(link => <a key={link.href} href={link.href} title={link.purpose}>{link.title} →</a>)}</div>}
        </div>
      </>}
    </dialog>
  </section>;
}


