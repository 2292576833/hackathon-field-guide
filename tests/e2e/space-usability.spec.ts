import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./ux-test.ts";
import type { IsolatedWorkspace } from "./isolated-workspace.ts";
import type { Project } from "../../src/modules/projects/model.ts";
import type { Me } from "../../src/components/site-shell.tsx";
import type { CanvasLayoutRecord } from "../../src/server/space-canvas-layouts.ts";
import { SPACE_COMPONENT_KINDS, type CanvasPlacement } from "../../src/modules/space-workflow/canvas-board.ts";
import { spaceFlowStorageKey } from "../../src/modules/space-workflow/graph-layout.ts";

// Browser exercises dispatch to the real application in a disposable migrated
// database. Production is never written and no external model/mail is called.
async function space(f: IsolatedWorkspace, suffix: string, items?: readonly CanvasPlacement[]) {
  const owner = await f.login(`usability-${suffix}@example.test`, "第一次参赛的人");
  const project = await f.request<Project>("projects", "POST", { name: `新人走查-${suffix}`, timezone: "Asia/Shanghai", goal: "帮新人找到比赛", minimumDeliverable: "选择兴趣后能看到比赛入口", deadline: new Date(Date.now() + 96 * 3600_000).toISOString() }, owner, 201);
  const apiBase = `projects/${project.id}`;
  if (items) await f.request(`${apiBase}/space-canvas`, "PUT", { expectedRevision: 0, items }, owner);
  return { owner, project, apiBase, base: `/app/projects/${project.id}` };
}
async function holdMove(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y); await page.mouse.down();
  await page.waitForTimeout(510); // Deliberately exercise the actual 450ms activation threshold.
  await page.mouse.move(x + dx, y + dy, { steps: 7 }); await page.mouse.up();
}
async function marqueeSelect(page: Page, marker: string, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y); await page.mouse.down();
  // Moving immediately used to cancel the 450ms candidate, so do not wait here.
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  const box = page.locator(marker); await expect(box).toBeVisible();
  const size = await box.boundingBox(); expect(size?.width).toBeGreaterThan(8); expect(size?.height).toBeGreaterThan(8);
  expect(await box.evaluate(node => getComputedStyle(node).borderTopStyle)).not.toBe("none");
  await page.mouse.up(); await expect(box).toHaveCount(0);
}
async function dispatchWheel(target: Locator, deltaY: number, modifier?: "ctrlKey" | "metaKey") {
  // A cancelable event makes native-scroll eligibility observable without the
  // browser scrolling the chosen coordinates away before later assertions.
  return target.evaluate((node, input) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: input.deltaY, ...(input.modifier ? { [input.modifier]: true } : {}) });
    node.dispatchEvent(event); return event.defaultPrevented;
  }, { deltaY, modifier });
}
function noExternal(f: IsolatedWorkspace) { expect(f.externalRequests).toEqual([]); }

test("account profile is a single form after load, repeated save and reload", async ({ workspace: f }) => {
  const owner = await f.login("unique-profile@example.test", "原始昵称");
  const page = await f.page(owner, 375);
  await page.goto("/app/account");
  await expect(page.getByRole("heading", { name: "我的 DSH 工作台", exact: true })).toBeVisible();
  const profiles = page.getByRole("heading", { name: "本人资料", exact: true });
  await expect(profiles).toHaveCount(1);
  for (const name of ["第一次保存", "第二次保存"]) {
    await page.getByLabel("昵称", { exact: true }).fill(name);
    await page.getByRole("button", { name: "保存本人资料", exact: true }).click();
    await expect.poll(async () => (await f.request<Me>("me", "GET", undefined, owner)).profile.displayName).toBe(name);
    await expect(page.getByRole("button", { name: "保存本人资料", exact: true })).toBeEnabled();
    await expect(profiles).toHaveCount(1);
  }
  await page.reload(); await expect(profiles).toHaveCount(1);
  await expect(page.getByLabel("昵称", { exact: true })).toHaveValue("第二次保存");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: ".runtime/previews/space-usability-account-mobile.png", fullPage: true });
  noExternal(f);
});

test("each flow action opens only its own form and invitation handoff has one dialog", async ({ workspace: f }) => {
  const { owner, base } = await space(f, "actions");
  const page = await f.page(owner, 375); await page.goto(base);
  async function open(id: string) { const node = page.locator(`[data-graph-node="action:${id}"] > button`).first(); await node.focus(); await page.keyboard.press("Enter"); return page.locator("dialog[open]"); }
  let dialog = await open("goal");
  await expect(dialog.getByPlaceholder("例如：帮第一次参赛的人快速找到适合自己的比赛。", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  dialog = await open("invite");
  await expect(dialog.getByLabel("作品目标", { exact: true })).toHaveCount(0);
  await dialog.getByRole("link", { name: "打开邀请队友窗口 →", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "邀请队友加入团队空间", exact: true })).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  dialog = await open("registration");
  await expect(dialog.getByText("当前确认规则", { exact: true })).toHaveCount(0);
  await expect(dialog.locator("#official-track")).toHaveCount(0);
  await expect(dialog.locator("#project-goal")).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (const id of ["assignment", "applied-plan"]) {
    dialog = await open(id);
    await expect(dialog.locator("#my-duties")).toHaveCount(0);
    await expect(dialog.getByRole("region", { name: "我能投入的时间", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("link").filter({ hasText: /计划|任务/ }).first()).toBeVisible();
    await page.keyboard.press("Escape");
  }
  noExternal(f);
});

test("all nine widgets move independently but scale only after marquee selection", async ({ workspace: f }) => {
  test.setTimeout(150_000);
  const { owner, base, apiBase } = await space(f, "widgets", []);
  const page = await f.page(owner);
  for (const kind of SPACE_COMPONENT_KINDS) {
    const saved = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner);
    await f.request(`${apiBase}/space-canvas`, "PUT", { expectedRevision: saved.revision, items: [{ instanceId: `${kind}-test`, kind, x: 40, y: 40, width: 380, collapsed: false }] }, owner);
    await page.goto(base);
    const card = page.locator(`[data-instance-id="${kind}-test"]`);
    await expect(card).toBeVisible();
    const box = await card.boundingBox(); if (!box) throw new Error(`Missing ${kind}`);
    await holdMove(page, box.x + 8, box.y + 8, 70, 45);
    await expect.poll(async () => (await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).items[0]?.x).toBe(110);
    await expect(card).toHaveAttribute("data-selected", "false");
    const beforeWheel = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner);
    expect(await dispatchWheel(card, -100)).toBe(false);
    await page.waitForTimeout(300);
    expect((await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).revision).toBe(beforeWheel.revision);
    const moved = await card.boundingBox(); if (!moved) throw new Error(`Missing ${kind}`);
    await marqueeSelect(page, "[data-canvas-marquee]", moved.x - 20, moved.y - 20, 40, 40);
    await expect(card).toHaveAttribute("data-selected", "true");
    await page.mouse.move(moved.x + 8, moved.y + 8); await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).items[0]?.scale ?? 1).toBeGreaterThan(1);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  }
  // Entering a space reconciles its existing change notices; gestures must not
  // trigger any other project mutation (tasks, assignments, deadlines or goal).
  expect(f.apiReads.filter(read => /^(POST|PATCH) projects\//.test(read) && !read.endsWith("/space-changes/reconcile"))).toEqual([]);
  noExternal(f);
});

test("marquee selects two cards and translates them in one saved layout; Escape cancels", async ({ workspace: f }) => {
  const items: CanvasPlacement[] = [
    { instanceId: "assistant-one", kind: "assistant", x: 40, y: 40, width: 280, collapsed: false },
    { instanceId: "scope-two", kind: "scope", x: 370, y: 40, width: 280, collapsed: false },
    { instanceId: "deadline-three", kind: "deadline", x: 760, y: 40, width: 280, collapsed: false },
  ];
  const { owner, base, apiBase } = await space(f, "marquee", items);
  const page = await f.page(owner); await page.goto(base);
  const first = page.locator('[data-instance-id="assistant-one"]'), second = page.locator('[data-instance-id="scope-two"]');
  await expect(first).toBeVisible(); await expect(second).toBeVisible();
  const box = await first.boundingBox(); if (!box) throw new Error("missing first");
  await marqueeSelect(page, "[data-canvas-marquee]", box.x - 20, box.y - 20, 650, 60);
  await expect(page.locator('[data-instance-id][data-selected="true"]')).toHaveCount(2);
  await expect(page.locator("[data-canvas-marquee]")).toHaveCount(0);
  const before = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner);
  await holdMove(page, box.x + 8, box.y + 8, 90, 60);
  await expect.poll(async () => (await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).revision).toBe(before.revision + 1);
  const after = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner);
  expect(after.items.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 130, y: 100 }, { x: 460, y: 100 }, { x: 760, y: 40 }]);
  await page.screenshot({ path: ".runtime/previews/space-usability-marquee.png" });
  await page.keyboard.press("Escape"); await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  await page.reload(); await expect(first).toBeVisible();
  expect((await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).items).toEqual(after.items);
  noExternal(f);
});

test("a long press on a collapsed card moves it while a short click still expands it", async ({ workspace: f }) => {
  const { owner, base, apiBase } = await space(f, "collapsed", [{ instanceId: "assistant-only", kind: "assistant", x: 40, y: 40, width: 280, collapsed: true }]);
  const page = await f.page(owner); await page.goto(base);
  const expand = page.getByRole("button", { name: "展开空间 AI 助手", exact: true });
  await expect(expand).toBeVisible(); const box = await expand.boundingBox(); if (!box) throw new Error("No expand button");
  await holdMove(page, box.x + box.width / 2, box.y + box.height / 2, 70, 50);
  await expect.poll(async () => (await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).items[0]?.x).toBe(110);
  await expect(page.locator('[data-instance-id="assistant-only"]')).toHaveAttribute("data-collapsed", "true");
  await expand.click(); await expect(page.getByRole("button", { name: "打开私人空间 AI", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开私人空间 AI", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "空间 AI", exact: true })).toBeVisible();
  noExternal(f);
});

test("a missing-deadline entry opens the actual goal editor rather than only returning to the canvas", async ({ workspace: f }) => {
  const { owner, base } = await space(f, "goal-link");
  const page = await f.page(owner, 375); await page.goto(`${base}#project-goal`);
  const dialog = page.getByRole("dialog", { name: "写清作品目标", exact: true });
  await expect(dialog.getByLabel("团队计划完成时间（北京时间）", { exact: true })).toBeVisible();
  await dialog.getByRole("link", { name: "继续安排任务 →", exact: true }).click();
  await page.waitForURL(`${base}/plan`);
  await expect(page.getByText("建立新的计划草案", { exact: true })).toBeVisible();
  noExternal(f);
});

test("flow-node marquee moves both actions without moving their outer widget or opening the editor", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "flow-marquee", [{ instanceId: "path-only", kind: "path", x: 40, y: 40, collapsed: false }]);
  const page = await f.page(owner); await page.goto(base);
  const savedPath = page.locator('[data-instance-id="path-only"]');
  await expect(savedPath).toBeVisible();
  const first = savedPath.locator('[data-graph-node="action:goal"]'), second = savedPath.locator('[data-graph-node="action:invite"]');
  await expect(first).toBeVisible(); await expect(second).toBeVisible();
  const one = await first.boundingBox(), two = await second.boundingBox(); if (!one || !two) throw new Error("Missing actions");
  const left = Math.min(one.x, two.x) - 10, top = Math.min(one.y, two.y) - 10;
  expect(await dispatchWheel(first, -100)).toBe(false);
  await marqueeSelect(page, "[data-flow-marquee]", left, top, Math.max(one.x + one.width, two.x + two.width) + 10 - left, Math.max(one.y + one.height, two.y + two.height) + 10 - top);
  await expect(savedPath.locator('[data-flow-selected="true"]')).toHaveCount(2);
  await holdMove(page, one.x + one.width / 2, one.y + one.height / 2, 90, 40);
  await expect.poll(async () => (await first.boundingBox())?.x).toBeCloseTo(one.x + 90, 0);
  expect((await second.boundingBox())?.x).toBeCloseTo(two.x + 90, 0);
  expect((await second.boundingBox())?.y).toBeCloseTo(two.y + 40, 0);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const saved = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner);
  expect(saved.items[0]).toMatchObject({ x: 40, y: 40 }); expect(saved.revision).toBe(1);
  const key = spaceFlowStorageKey(project.id, owner.userId);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toContain("action:goal");
  await page.reload(); await expect(first).toBeVisible();
  await expect.poll(async () => (await first.boundingBox())?.x).toBeCloseTo(one.x + 90, 0);
  noExternal(f);
});

test("selected widgets scale with one multiplier, preserve limits and reload; unselected wheel remains native", async ({ workspace: f }) => {
  const items: CanvasPlacement[] = [
    { instanceId: "assistant-one", kind: "assistant", x: 40, y: 40, width: 280, scale: 1, collapsed: false },
    { instanceId: "scope-two", kind: "scope", x: 370, y: 40, width: 280, scale: 1.9, collapsed: false },
    { instanceId: "deadline-three", kind: "deadline", x: 1000, y: 40, width: 280, scale: 1, collapsed: false },
  ];
  const { owner, base, apiBase } = await space(f, "group-scale", items);
  const page = await f.page(owner); await page.goto(base);
  const first = page.locator('[data-instance-id="assistant-one"]'), second = page.locator('[data-instance-id="scope-two"]'), other = page.locator('[data-instance-id="deadline-three"]');
  await expect(first).toBeVisible(); await expect(second).toBeVisible();
  const menu = first.locator("details").first(); await menu.locator("summary").click();
  for (const name of ["窄一点", "宽一点", "缩小选中项", "放大选中项", "恢复100%"]) await expect(menu.getByRole("button", { name, exact: true })).toBeDisabled();
  await menu.locator("summary").click();
  const box = await first.boundingBox(); if (!box) throw new Error("Missing first");
  await marqueeSelect(page, "[data-canvas-marquee]", box.x - 20, box.y - 20, 400, 60);
  await expect(page.locator('[data-instance-id][data-selected="true"]')).toHaveCount(2);
  const before = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner);
  expect(await dispatchWheel(other, -100)).toBe(false);
  expect(await dispatchWheel(first, -100, "ctrlKey")).toBe(false);
  expect(await dispatchWheel(first, -100, "metaKey")).toBe(false);
  await page.waitForTimeout(300);
  expect((await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).revision).toBe(before.revision);
  await expect(page.locator('[data-instance-id][data-selected="true"]')).toHaveCount(2);
  // Two wheel ticks hit the second member's maximum and cap the whole group.
  expect(await dispatchWheel(first, -100)).toBe(true); expect(await dispatchWheel(first, -100)).toBe(true);
  await expect.poll(async () => (await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).items[1]?.scale).toBe(2);
  const scaled = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner), factor = 2 / 1.9;
  expect(scaled.revision).toBe(before.revision + 1);
  expect(scaled.items[0]?.scale).toBeCloseTo(factor, 10);
  expect(scaled.items[1]!.x - scaled.items[0]!.x).toBeCloseTo(330 * factor, 10);
  expect(scaled.items[2]).toEqual(before.items[2]);
  await menu.locator("summary").click();
  await expect(menu.getByRole("button", { name: "宽一点", exact: true })).toBeDisabled();
  await menu.getByRole("button", { name: "恢复100%", exact: true }).click();
  await expect.poll(async () => (await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).revision).toBe(scaled.revision + 1);
  const reset = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner);
  expect(reset.items[0]?.scale).toBeCloseTo(1, 10); expect(reset.items[1]?.scale).toBeCloseTo(1.9, 10);
  expect(reset.items[1]!.x - reset.items[0]!.x).toBeCloseTo(330, 10);
  await page.reload(); await expect(first).toBeVisible();
  expect((await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).items).toEqual(reset.items);
  await expect(first).toHaveAttribute("data-selected", "false");
  expect(await dispatchWheel(first, -100)).toBe(false);
  // Exercise actual native wheel scrolling after the guarded dispatch checks.
  const beforeScroll = await page.evaluate(() => ({ y: scrollY, canvas: document.querySelector<HTMLElement>('[data-instance-id]')?.parentElement?.parentElement?.scrollTop ?? 0 }));
  const actual = await first.boundingBox(); if (!actual) throw new Error("Missing reloaded first");
  await page.mouse.move(actual.x + 8, actual.y + 8); await page.mouse.wheel(0, 200);
  await expect.poll(async () => page.evaluate(() => ({ y: scrollY, canvas: document.querySelector<HTMLElement>('[data-instance-id]')?.parentElement?.parentElement?.scrollTop ?? 0 }))).not.toEqual(beforeScroll);
  noExternal(f);
});

test("flow selection alone enables proportional group wheel, menu and keyboard zoom without changing outer layout", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "flow-scale", [{ instanceId: "path-only", kind: "path", x: 40, y: 40, collapsed: false }]);
  const page = await f.page(owner); await page.goto(base);
  const outer = page.locator('[data-instance-id="path-only"]'), first = outer.locator('[data-graph-node="action:goal"]'), second = outer.locator('[data-graph-node="action:invite"]');
  await expect(first).toBeVisible();
  const one = await first.boundingBox(); if (!one) throw new Error("Missing goal");
  await holdMove(page, one.x + one.width / 2, one.y + one.height / 2, 20, 10);
  await expect(first).toHaveAttribute("data-flow-selected", "false");
  await expect(first).toHaveAttribute("data-scale", "1");
  expect(await dispatchWheel(first, -100)).toBe(false);
  await first.locator('button[data-flow-options]').click();
  await expect(first.getByRole("button", { name: "放大选中节点", exact: true })).toBeDisabled();
  await first.getByRole("button", { name: "完成", exact: true }).click();
  const a = await first.boundingBox(), b = await second.boundingBox(); if (!a || !b) throw new Error("Missing actions");
  const left = Math.min(a.x, b.x) - 10, top = Math.min(a.y, b.y) - 10;
  await marqueeSelect(page, "[data-flow-marquee]", left, top, Math.max(a.x + a.width, b.x + b.width) + 10 - left, Math.max(a.y + a.height, b.y + b.height) + 10 - top);
  await expect(outer.locator('[data-flow-selected="true"]')).toHaveCount(2);
  await expect(outer).toHaveAttribute("data-selected", "false");
  const key = spaceFlowStorageKey(project.id, owner.userId);
  const readPoints = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ id: string; x: number; y: number; scale?: number }>, key);
  const before = await readPoints();
  expect(await dispatchWheel(outer.locator('[data-graph-node]:not([data-flow-selected="true"])').first(), -100)).toBe(false);
  expect(await dispatchWheel(first, -100, "ctrlKey")).toBe(false);
  expect(await dispatchWheel(first, -100, "metaKey")).toBe(false);
  expect(await dispatchWheel(first, -100)).toBe(true);
  await expect(first).toHaveAttribute("data-scale", "1.05"); await expect(second).toHaveAttribute("data-scale", "1.05");
  await expect.poll(async () => (await readPoints()).find(point => point.id === "action:goal")?.scale).toBe(1.05);
  const after = await readPoints();
  const original = ["action:goal", "action:invite"].map(id => before.find(point => point.id === id)!);
  const scaled = ["action:goal", "action:invite"].map(id => after.find(point => point.id === id)!);
  expect(scaled[1]!.x - scaled[0]!.x).toBeCloseTo((original[1]!.x - original[0]!.x) * 1.05, 10);
  expect(scaled[1]!.y - scaled[0]!.y).toBeCloseTo((original[1]!.y - original[0]!.y) * 1.05, 10);
  await first.locator("button").first().focus(); await page.keyboard.press("Alt+-");
  await expect(first).toHaveAttribute("data-scale", "1"); await expect(second).toHaveAttribute("data-scale", "1");
  await first.locator('button[data-flow-options]').click(); await first.getByRole("button", { name: "放大选中节点", exact: true }).click();
  await expect(first).toHaveAttribute("data-scale", "1.05"); await expect(second).toHaveAttribute("data-scale", "1.05");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect.poll(async () => (await readPoints()).find(point => point.id === "action:goal")?.scale).toBe(1.05);
  await page.reload(); await expect(first).toHaveAttribute("data-scale", "1.05"); await expect(second).toHaveAttribute("data-scale", "1.05");
  await expect(first).toHaveAttribute("data-flow-selected", "false"); expect(await dispatchWheel(first, -100)).toBe(false);
  const saved = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner);
  expect(saved.items[0]).toMatchObject({ x: 40, y: 40 }); expect(saved.revision).toBe(1);
  expect(f.apiReads.filter(read => read === `PUT ${apiBase}/space-canvas`)).toEqual([]);
  noExternal(f);
});
