import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceGuideStep } from "./guide-tree.ts";
import { buildSpaceFlowGraph, clampSpaceFlowScale, measureSpaceFlowNodes, mobileSpaceFlowNodes, moveSpaceFlowOrder, readSpaceFlowOrder, readSpaceFlowPositions, scaleSpaceFlowNodes, spaceFlowBounds, spaceFlowPaths, spaceFlowStorageKey } from "./graph-layout.ts";

test("reloading a flow preserves the fractional geometry of a scaled group", () => {
  const graph = buildSpaceFlowGraph(steps);
  const saved = [
    { id: "action:goal", x: 40.123456789, y: 77.333333333, scale: 1.037654321 },
    { id: "action:invite", x: 397.987654321, y: 93.666666666, scale: 1.29706790125 },
  ];
  const restored = readSpaceFlowPositions(graph.nodes, JSON.stringify(saved));
  for (const { id, ...position } of saved) assert.deepEqual(restored[id], position);
  assert.equal(restored["action:invite"]!.scale! / restored["action:goal"]!.scale!, 1.25);
});

const steps: SpaceGuideStep[] = [{ id: "enter", title: "作品目标", summary: "", next: "", nodes: [
  { id: "goal", title: "写清作品目标", when: "", actions: [], condition: "", fact: { status: "unknown", label: "", explanation: "" }, next: "",
    links: [{ title: "保存目标", href: "/goal", purpose: "真实表单" }, { title: "邀请", href: "/invite", purpose: "真实邀请" }], tools: [{ title: "教程", href: "/library", purpose: "原创教程" }] },
  { id: "invite", title: "邀请队友", when: "", actions: [], condition: "", fact: { status: "check", label: "", explanation: "" }, next: "", links: [], tools: [] },
] }, { id: "planning", title: "分工时间", summary: "", next: "", nodes: [
  { id: "duties-time", title: "确认时间", when: "", actions: [], condition: "", fact: { status: "check", label: "", explanation: "" }, next: "", links: [{ title: "计划页", href: "/plan", purpose: "原安排" }], tools: [] },
] }];

test("the simplified canvas preserves all actions and hides only resource branches, without deleting step links", () => {
  const prior = structuredClone(steps), graph = buildSpaceFlowGraph(steps, { includeResources: false });
  assert.equal(graph.nodes.length, 3);
  assert.ok(graph.nodes.every(node => node.kind === "action"));
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every(edge => edge.kind === "main"));
  assert.deepEqual(steps, prior);
  const connected = new Set(graph.edges.flatMap(edge => [edge.from, edge.to]));
  assert.ok(graph.nodes.every(node => connected.has(node.id)));
});

test("every action and every existing resource is directly represented and connected", () => {
  const graph = buildSpaceFlowGraph(steps);
  assert.equal(graph.nodes.filter(node => node.kind === "action").length, 3);
  assert.equal(graph.nodes.filter(node => node.kind !== "action").length, 4);
  assert.equal(graph.stages.length, 2);
  assert.equal(graph.edges.filter(edge => edge.kind === "main").length, 2);
  assert.equal(graph.edges.filter(edge => edge.kind === "resource").length, 4);
  assert.equal(new Set(graph.nodes.map(node => node.id)).size, graph.nodes.length);
  for (const resource of graph.nodes.filter(node => node.kind !== "action")) {
    assert.ok(graph.edges.some(edge => edge.from === `action:${resource.actionId}` && edge.to === resource.id));
    assert.ok(resource.href);
  }
});

test("default nodes do not overlap and bounds contain every real component", () => {
  const graph = buildSpaceFlowGraph(steps), bounds = spaceFlowBounds(graph.nodes);
  for (const node of graph.nodes) {
    assert.ok(node.x >= 0 && node.y >= 0);
    assert.ok(node.x + node.width <= bounds.width && node.y + node.height <= bounds.height);
    for (const other of graph.nodes.filter(item => item.id !== node.id)) {
      assert.ok(node.x + node.width <= other.x || other.x + other.width <= node.x || node.y + node.height <= other.y || other.y + other.height <= node.y);
    }
  }
  assert.ok(bounds.width - Math.max(...graph.nodes.map(node => node.x + node.width)) >= 320);
  assert.ok(bounds.height - Math.max(...graph.nodes.map(node => node.y + node.height)) >= 320);
});

test("connectors follow moved nodes and measured dimensions without invalid paths", () => {
  const graph = buildSpaceFlowGraph(steps), original = spaceFlowPaths(graph.nodes, graph.edges);
  const moved = graph.nodes.map(node => node.id === "action:goal" ? { ...node, x: 900, y: 600, height: 130 } : node);
  const updated = spaceFlowPaths(moved, graph.edges);
  assert.notEqual(updated[0]!.d, original[0]!.d);
  assert.ok(updated.every(path => !/NaN|undefined|Infinity/.test(path.d)));
  assert.ok(spaceFlowBounds(moved).height >= 730);
  assert.deepEqual(spaceFlowPaths([], graph.edges), []);
});

test("desktop v2 keys preserve old history and isolate each account and space", () => {
  assert.notEqual(spaceFlowStorageKey("a", "one"), "hackathon.space.canvas.a.one");
  assert.notEqual(spaceFlowStorageKey("a", "one"), spaceFlowStorageKey("a", "two"));
  assert.notEqual(spaceFlowStorageKey("a", "one"), spaceFlowStorageKey("b", "one"));
  assert.notEqual(spaceFlowStorageKey("a", "one"), spaceFlowStorageKey("a", "one", true));
});

test("saved positions accept only known IDs and safe points, filling all new nodes", () => {
  const graph = buildSpaceFlowGraph(steps);
  const original = readSpaceFlowPositions(graph.nodes, null);
  assert.deepEqual(readSpaceFlowPositions(graph.nodes, "bad json"), original);
  const restored = readSpaceFlowPositions(graph.nodes, JSON.stringify([{ id: "action:goal", x: 640, y: 240 }, { id: "action:invite", x: -1, y: 1 }, { id: "not-a-node", x: 500, y: 500 }]));
  assert.deepEqual(restored["action:goal"], { x: 640, y: 240 });
  assert.deepEqual(restored["action:invite"], original["action:invite"]);
  assert.equal(restored["not-a-node"], undefined);
  assert.equal(Object.keys(restored).length, graph.nodes.length);
});

test("phone has its own complete order and derived single-column positions", () => {
  const graph = buildSpaceFlowGraph(steps), desktop = structuredClone(graph.nodes);
  const order = readSpaceFlowOrder(graph.nodes, JSON.stringify(["action:invite", "action:invite", "unknown"]));
  assert.equal(order[0], "action:invite"); assert.equal(order.length, graph.nodes.length);
  const next = moveSpaceFlowOrder(order, "action:goal", 0);
  assert.equal(next[0], "action:goal"); assert.equal(next.length, order.length);
  assert.deepEqual(moveSpaceFlowOrder(order, "unknown", 0), order);
  const phone = mobileSpaceFlowNodes(graph.nodes, next, 320);
  assert.ok(phone.every(node => node.x + node.width <= 320));
  assert.ok(phone.every((node, index) => index === 0 || node.y >= phone[index - 1]!.y + phone[index - 1]!.height));
  assert.equal(spaceFlowPaths(phone, graph.edges, true).length, graph.edges.length);
  assert.deepEqual(graph.nodes, desktop);
  assert.deepEqual(readSpaceFlowOrder(graph.nodes, "bad json"), graph.nodes.map(node => node.id));
});

test("layout building and reading never mutate guide facts or create completion state", () => {
  const snapshot = structuredClone(steps);
  const graph = buildSpaceFlowGraph(steps);
  readSpaceFlowPositions(graph.nodes, null); readSpaceFlowOrder(graph.nodes, null); spaceFlowPaths(graph.nodes, graph.edges);
  assert.deepEqual(steps, snapshot);
  assert.ok(graph.nodes.every(node => !("completed" in node) && !("revision" in node)));
});

test("node scaling is clamped to readable bounds and SVG endpoints use the scaled rectangles", () => {
  const graph = buildSpaceFlowGraph(steps), original = structuredClone(graph.nodes);
  assert.equal(clampSpaceFlowScale(0), 0.5); assert.equal(clampSpaceFlowScale(4), 2);
  assert.equal(clampSpaceFlowScale(NaN), 1); assert.equal(clampSpaceFlowScale(1.234), 1.234);
  const doubled = scaleSpaceFlowNodes(graph.nodes.map(node => ({ ...node, scale: 2 })));
  const action = doubled.find(node => node.id === "action:goal")!;
  assert.equal(action.width, original[0]!.width * 2);
  assert.equal(action.height, original[0]!.height * 2);
  const main = spaceFlowPaths(doubled, graph.edges).find(edge => edge.from === action.id && edge.kind === "main")!;
  assert.ok(main.d.startsWith(`M ${action.x + action.width / 2} ${action.y + action.height}`));
  assert.ok(spaceFlowBounds(doubled).width > spaceFlowBounds(original).width);
  assert.deepEqual(graph.nodes, original);
  const phone = mobileSpaceFlowNodes(doubled, graph.nodes.map(node => node.id), 320);
  assert.ok(phone.every(node => node.scale === 1));
});

test("measurement precedes scale on both axes and resource anchors land on the current rectangle", () => {
  const graph = buildSpaceFlowGraph(steps), snapshot = structuredClone(graph.nodes);
  const measured = measureSpaceFlowNodes(graph.nodes, {
    "action:goal": { width: 300, height: 110 },
    "resource:goal:link:0": { width: 240, height: 100 },
    "action:invite": { width: NaN, height: -1 },
  });
  const placed = scaleSpaceFlowNodes(measured.map(node => node.id === "action:goal" ? { ...node, x: 20, y: 40, scale: 1.5 }
    : node.id === "resource:goal:link:0" ? { ...node, x: 600, y: 200, scale: 0.5 } : node));
  const action = placed.find(node => node.id === "action:goal")!, resource = placed.find(node => node.id === "resource:goal:link:0")!;
  assert.equal(action.width, 450); assert.equal(action.height, 165);
  assert.equal(resource.width, 120); assert.equal(resource.height, 50);
  const path = spaceFlowPaths(placed, graph.edges).find(edge => edge.to === resource.id)!;
  assert.ok(path.d.startsWith(`M ${action.x + action.width} ${action.y + action.height / 2}`));
  assert.ok(path.d.endsWith(`H ${resource.x + resource.width / 2} V ${resource.y}`));
  assert.deepEqual(measured.find(node => node.id === "action:invite"), snapshot.find(node => node.id === "action:invite"));
  assert.deepEqual(graph.nodes, snapshot);
});

test("links moved left and actions moved upward attach to the correct facing edges", () => {
  const graph = buildSpaceFlowGraph(steps);
  const placed = scaleSpaceFlowNodes(graph.nodes.map(node => node.id === "action:goal" ? { ...node, x: 500, y: 500, scale: 1.5 }
    : node.id === "action:invite" ? { ...node, x: 600, y: 100, scale: 0.5 }
    : node.id === "resource:goal:link:0" ? { ...node, x: 0, y: 600, scale: 2 } : node));
  const action = placed.find(node => node.id === "action:goal")!, next = placed.find(node => node.id === "action:invite")!, resource = placed.find(node => node.id === "resource:goal:link:0")!;
  const paths = spaceFlowPaths(placed, graph.edges);
  const main = paths.find(edge => edge.from === action.id && edge.kind === "main")!, branch = paths.find(edge => edge.to === resource.id)!;
  assert.ok(main.d.startsWith(`M ${action.x + action.width / 2} ${action.y}`));
  assert.ok(main.d.endsWith(`${next.x + next.width / 2} ${next.y + next.height}`));
  assert.ok(branch.d.startsWith(`M ${action.x} ${action.y + action.height / 2}`));
  assert.ok(branch.d.endsWith(`${resource.x + resource.width} ${resource.y + resource.height / 2}`));
});

test("phone connections keep two visible lanes and small screens cannot overflow", () => {
  const graph = buildSpaceFlowGraph(steps);
  const desktopPositions = readSpaceFlowPositions(graph.nodes, JSON.stringify([{ id: "action:goal", x: 5000, y: 2000, scale: 2 }]));
  const before = structuredClone(desktopPositions);
  for (const width of [180, 240, 320, 390]) {
    const phone = mobileSpaceFlowNodes(graph.nodes, graph.nodes.map(node => node.id), width);
    assert.ok(phone.every(node => node.x + node.width <= width));
    const paths = spaceFlowPaths(phone, graph.edges, true);
    for (const path of paths) {
      const from = phone.find(node => node.id === path.from)!, to = phone.find(node => node.id === path.to)!;
      assert.equal(path.d, `M ${from.x} ${from.y + from.height / 2} H ${path.kind === "main" ? 8 : 24} V ${to.y + to.height / 2} H ${to.x}`);
    }
  }
  assert.deepEqual(desktopPositions, before);
});

test("labels are short projections while actual hrefs and detailed guide content stay intact", () => {
  const graph = buildSpaceFlowGraph(steps), snapshot = structuredClone(steps);
  assert.equal(graph.nodes.find(node => node.id === "action:duties-time")!.title, "选职责，填时间");
  assert.deepEqual(graph.nodes.filter(node => node.kind !== "action").map(node => node.href), ["/goal", "/invite", "/library", "/plan"]);
  assert.deepEqual(steps, snapshot);
});
