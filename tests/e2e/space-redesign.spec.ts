import type { Page, Locator } from "@playwright/test";
import { test, expect } from "./ux-test.ts";
import type { FixtureIdentity, IsolatedWorkspace } from "./isolated-workspace.ts";
import type { Project, MemberAvailability } from "../../src/modules/projects/model.ts";
import type { ProjectDetail } from "../../src/components/projects-client.tsx";
import type { SpaceDocument } from "../../src/server/space-documents.ts";
import type { CanvasLayoutRecord } from "../../src/server/space-canvas-layouts.ts";
import type { SpaceManualTodo } from "../../src/modules/space-workflow/todos.ts";
import { spaceFlowStorageKey } from "../../src/modules/space-workflow/graph-layout.ts";

// Real application handlers, migrated in-memory PostgreSQL, and intercepted API
// requests. The page server supplies assets only; no production writes, mail,
// external network, worker, or real model are used by these acceptance cases.
async function space(f: IsolatedWorkspace, suffix: string) {
  const owner = await f.login(`redesign-${suffix}-owner@example.test`, "空间负责人");
  const project = await f.request<Project>("projects", "POST", {
    name: `协作重设计验收-${suffix}`, timezone: "Asia/Shanghai",
    goal: "帮助第一次参赛的人完成一条可用流程", minimumDeliverable: "能运行、能交接的一份核心演示",
  }, owner, 201);
  return { owner, project, base: `/app/projects/${project.id}`, apiBase: `projects/${project.id}` };
}
async function join(f: IsolatedWorkspace, owner: FixtureIdentity, project: Project, suffix: string) {
  const member = await f.login(`redesign-${suffix}-member@example.test`, "一起做作品的队友");
  const detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
  const issued = await f.request<{ token: string }>(`projects/${project.id}/invitations`, "POST", {
    expectedRevision: detail.project.revision, role: "member", maxUses: 1,
  }, owner, 201);
  await f.request(`invitations/${issued.token}/accept`, "POST", {}, member);
  return member;
}
function assertIsolated(f: IsolatedWorkspace) {
  expect(f.externalRequests, "No request should leave the owned fixture origin").toEqual([]);
  expect(f.apiReads.filter(read => /^(POST|PUT|PATCH) (?:navigator\/messages|projects\/[^/]+\/(?:assistant\/messages|feasibility)(?:$|\/))/.test(read)), "Acceptance must never request a real model").toEqual([]);
}
async function loaded(page: Page, base: string, name: string) {
  await page.goto(base);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator("#space-path-line")).toHaveAttribute("data-presentation", "canvas");
}
function beijingLocal(epochMs: number) { return new Date(epochMs + 8 * 60 * 60_000).toISOString().slice(0, 16); }
async function docMenu(item: Locator) {
  const menu = item.locator("[data-space-document-menu]");
  if (await menu.getAttribute("open") === null) await menu.locator("summary").click();
  return menu;
}
async function docAction(item: Locator, name: string) {
  await (await docMenu(item)).getByRole("button", { name, exact: true }).click();
}

test("375px default canvas shows the space, invitations and one space assistant; keyboard nodes return focus", async ({ workspace: f }) => {
  const { owner, project, base } = await space(f, "phone");
  const page = await f.page(owner, 375);
  await loaded(page, base, project.name);
  await expect(page.locator('[data-instance-id="todos-1"]')).toBeVisible();
  await expect(page.locator('[data-instance-id="overview-1"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toBeVisible();
  const assistant = page.getByRole("button", { name: "空间 AI", exact: true });
  await expect(assistant).toHaveCount(1); await expect(assistant).toBeVisible();
  await expect(page.locator("#space-todos")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "The phone work view must not require horizontal page scrolling").toBeTruthy();

  const firstStep = page.locator('[data-graph-node="action:goal"] > button').first();
  await firstStep.focus(); await page.keyboard.press("Enter");
  const stepDialog = page.getByRole("dialog", { name: "写清作品目标", exact: true });
  await expect(stepDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(stepDialog).not.toBeVisible(); await expect(firstStep).toBeFocused();

  await assistant.focus(); await page.keyboard.press("Space");
  const assistantDialog = page.getByRole("dialog", { name: "空间 AI", exact: true });
  await expect(assistantDialog).toBeVisible();
  await assistantDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(assistantDialog).not.toBeVisible(); await expect(assistant).toBeFocused();

  await page.getByRole("button", { name: "邀请队友", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "邀请队友加入团队空间", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(f.apiReads.some(read => read === `PUT projects/${project.id}/space-canvas`), "Reading the default view must not modify layout").toBe(false);
  assertIsolated(f);
});

test("the inline time window form saves timezone, windows and the person's revision through the real handler", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "time");
  await join(f, owner, project, "time"); // The project revision is now different from availability revision 0.
  const detail = await f.request<ProjectDetail>(apiBase, "GET", undefined, owner);
  expect(detail.project.revision).toBeGreaterThan(0);
  const page = await f.page(owner, 375);
  const requests: Record<string, unknown>[] = [];
  page.on("request", request => { if (request.method() === "PUT" && new URL(request.url()).pathname.endsWith("/my-availability")) requests.push(request.postDataJSON()); });
  await loaded(page, base, project.name);
  const planning = page.locator('[data-graph-node="action:duties-time"] > button').first();
  await planning.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "选职责，填时间", exact: true });
  const times = dialog.getByRole("region", { name: "我能投入的时间", exact: true });
  await expect(times).toBeVisible();
  const start = Math.ceil((Date.now() + 24 * 60 * 60_000) / 60_000) * 60_000;
  await times.getByLabel("时间段 1 · 开始（北京时间）", { exact: true }).fill(beijingLocal(start));
  await times.getByLabel("结束（北京时间）", { exact: true }).fill(beijingLocal(start + 90 * 60_000));
  await times.getByRole("button", { name: "确认并保存可用时间", exact: true }).click();
  await expect.poll(async () => (await f.request<{ availability: MemberAvailability | null }>(`${apiBase}/my-availability`, "GET", undefined, owner)).availability?.effectiveMinutes).toBe(90);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ expectedRevision: 0, timezone: "Asia/Shanghai", windows: [{ effectiveMinutes: 90 }] });
  expect(Object.hasOwn(requests[0]!, "effectiveMinutes")).toBe(false);
  const saved = await f.request<{ availability: MemberAvailability }>(`${apiBase}/my-availability`, "GET", undefined, owner);
  expect(saved.availability.revision).toBe(1); expect(saved.availability.windows).toHaveLength(1);
  await page.keyboard.press("Escape"); await expect(planning).toBeFocused();
  assertIsolated(f);
});

test("a read-only teammate reads and selects the full txt-style document, copies it and sees a private memo appear immediately", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "long-document");
  const member = await join(f, owner, project, "long-document");
  const tail = "最后一行：视频录制前请按这个版本重新验证核心流程。";
  const body = Array.from({ length: 48 }, (_, index) => `${index + 1}. 完成接口联调之后，按照记录复现核心流程，留下版本与检查依据。`).join("\n") + `\n${tail}`;
  const document = await f.request<SpaceDocument>(`${apiBase}/space-documents`, "POST", { title: "Demo 完整交接说明", body }, owner, 201);
  const page = await f.page(member, 375);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: f.origin });
  await loaded(page, base, project.name);
  const item = page.locator(`#space-document-${document.id}`);
  const fullText = item.locator("[data-space-document-text]");
  await expect(fullText).toBeVisible(); expect(await fullText.textContent()).toBe(body);
  await expect(item.getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
  await item.locator("summary").click();
  const selection = await fullText.evaluate(element => {
    const range = window.document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    return { text: selection?.toString(), userSelect: getComputedStyle(element).userSelect, overflowY: getComputedStyle(element).overflowY, internallyClipped: element.scrollHeight > element.clientHeight + 1 };
  });
  expect(selection).toMatchObject({ text: body, userSelect: "text", overflowY: "visible", internallyClipped: false });
  await docAction(item, "复制正文");
  await expect(page.getByText("已复制完整正文。", { exact: true })).toBeVisible();
  // Windows clipboard uses CRLF; verify every character and line after the
  // platform's newline convention is normalized, without trimming content.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(body);
  await docAction(item, "加入私人备忘");
  await expect(page.locator("#space-todos").getByText(`阅读：${document.title}`, { exact: true })).toBeVisible();
  const mine = await f.request<SpaceManualTodo[]>(`${apiBase}/space-todos`, "GET", undefined, member);
  const theirs = await f.request<SpaceManualTodo[]>(`${apiBase}/space-todos`, "GET", undefined, owner);
  expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ title: `阅读：${document.title}`, status: "open" }); expect(theirs).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  assertIsolated(f);
});

test("shared editing by a teammate persists actual text and the author can read the saved new version", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "shared-document");
  const member = await join(f, owner, project, "shared-document");
  const document = await f.request<SpaceDocument>(`${apiBase}/space-documents`, "POST", { title: "共同完善的演示说明", body: "作者原始说明" }, owner, 201);
  const ownerPage = await f.page(owner), memberPage = await f.page(member);
  await loaded(ownerPage, base, project.name); await loaded(memberPage, base, project.name);
  const ownerItem = ownerPage.locator(`#space-document-${document.id}`), memberItem = memberPage.locator(`#space-document-${document.id}`);
  await expect(memberItem.getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
  await docAction(ownerItem, "允许队友编辑");
  await expect((await docMenu(ownerItem)).getByRole("button", { name: "收回队友编辑", exact: true })).toBeVisible();
  await docAction(memberItem, "刷新文档");
  await docAction(memberItem, "编辑");
  const updated = "队友补充：先复现核心演示，记录步骤、真实版本和已知限制，之后才能录制视频。";
  await memberItem.getByLabel("正文", { exact: true }).fill(updated);
  await docAction(memberItem, "保存");
  await expect(memberItem.getByText(updated, { exact: true })).toBeVisible();
  const saved = (await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner)).find(item => item.id === document.id)!;
  expect(saved).toMatchObject({ body: updated, authorId: owner.userId, revision: 3, teamEditable: true });
  await docAction(ownerItem, "刷新文档");
  await expect(ownerItem.getByText(updated, { exact: true })).toBeVisible();
  assertIsolated(f);
});

test("long press moves without a handle, hover wheel scales, and phone use preserves desktop preferences", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "canvas");
  const original = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "PUT", { expectedRevision: 0, items: [
    { instanceId: "documents-existing", kind: "documents", x: 24, y: 24, width: 520, height: 310, scale: 1.1, collapsed: false },
    { instanceId: "path-existing", kind: "path", x: 760, y: 70, width: 350, height: 280, scale: 1, collapsed: false },
  ] }, owner);
  const page = await f.page(owner, 1440);
  const puts: unknown[] = [];
  page.on("request", request => { if (request.method() === "PUT" && new URL(request.url()).pathname.endsWith("/space-canvas")) puts.push(request.postDataJSON()); });
  await loaded(page, base, project.name);
  const card = page.locator('[data-instance-id="documents-existing"]');
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox(); if (!box) throw new Error("Owned canvas card is not visible");
  expect(await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).toEqual(original);
  // Use the document frame's edge; its text/editor remains selectable.
  await page.mouse.move(box.x + 2, box.y + 50); await page.mouse.down();
  await page.waitForTimeout(520); await page.mouse.move(box.x + 82, box.y + 90); await page.mouse.up();
  await expect.poll(async () => (await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).items.find(item => item.instanceId === "documents-existing")?.x).toBe(104);
  expect(puts).toHaveLength(1);
  const movedBox = await card.boundingBox(); if (!movedBox) throw new Error("Moved document is not visible");
  await page.mouse.move(movedBox.x + 2, movedBox.y + 50); await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).items.find(item => item.instanceId === "documents-existing")?.scale).toBe(1.15);
  const edited = await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner);
  expect(edited.items[0]).toMatchObject({ x: 104, y: 64, width: 520, height: 310, scale: 1.15 });
  expect(edited.items[1]).toEqual(original.items[1]);
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Mobile canvas is a flow layout").toBeTruthy();
  expect(await f.request<CanvasLayoutRecord>(`${apiBase}/space-canvas`, "GET", undefined, owner)).toEqual(edited);
  expect(puts).toHaveLength(2);
  assertIsolated(f);
});

test("an archived space still shows document text but removes document, memo and invitation write entries", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "archived");
  const document = await f.request<SpaceDocument>(`${apiBase}/space-documents`, "POST", { title: "保留的交接记录", body: "归档后仍然可以完整阅读这份记录。" }, owner, 201);
  await f.request(`${apiBase}/space-todos`, "POST", { title: "归档前的私人备忘", note: "留作回顾" }, owner, 201);
  const detail = await f.request<ProjectDetail>(apiBase, "GET", undefined, owner);
  await f.request(`${apiBase}/stage`, "POST", { expectedRevision: detail.project.revision, stage: "archived", reason: "协作界面只读验收" }, owner);
  const page = await f.page(owner, 375);
  await loaded(page, base, project.name);
  await expect(page.locator(`#space-document-${document.id}`).getByText(document.body, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toHaveCount(0);
  const docs = page.locator("#space-documents"), todos = page.locator("#space-todos");
  await docs.locator("summary").click();
  for (const name of ["保存", "加入私人备忘", "编辑", "允许队友编辑", "删除文档"]) await expect(docs.getByRole("button", { name, exact: true })).toHaveCount(0);
  for (const name of ["加入我的待办", "标记完成", "删除"]) await expect(todos.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(docs.getByRole("button", { name: "复制正文", exact: true })).toBeVisible();
  const planning = page.locator('[data-graph-node="action:duties-time"] > button').first();
  await planning.click();
  const dialog = page.getByRole("dialog", { name: "选职责，填时间", exact: true });
  await expect(dialog.getByRole("button", { name: "确认并保存可用时间", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("时间段 1 · 开始（北京时间）", { exact: true })).toBeDisabled();
  expect(f.apiReads.filter(read => /^(POST|PUT|PATCH|DELETE) projects\//.test(read)), "Archival browsing should not invoke business writes").toEqual([]);
  assertIsolated(f);
});

test("a new empty space puts its goal first and the overview action opens the real goal form in place", async ({ workspace: f }) => {
  const owner = await f.login("redesign-empty-owner@example.test", "第一次参赛");
  const project = await f.request<Project>("projects", "POST", { name: "先确定目标的新人空间", timezone: "Asia/Shanghai" }, owner, 201);
  const page = await f.page(owner, 375);
  await loaded(page, `/app/projects/${project.id}`, project.name);
  await expect(page.locator('#space-todos li[data-kind="fill"]').first()).toContainText("写清楚这次要做出什么");
  const next = page.locator("#space-overview").getByRole("button", { name: "继续处理 →", exact: true });
  await next.click();
  const dialog = page.getByRole("dialog", { name: "写清作品目标", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("作品要解决什么问题", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(next).toBeFocused();
  assertIsolated(f);
});

test("simplified flow actions keep their lines; node wheel and long press never change task facts or the parent layout", async ({ workspace: f }) => {
  const { owner, project, base } = await space(f, "flow");
  const page = await f.page(owner);
  await loaded(page, base, project.name);
  const graph = page.locator("#space-path-line");
  await expect(graph.locator("[data-graph-node]")).toHaveCount(16);
  await expect(graph.locator("svg > path[data-kind]")).toHaveCount(15);
  await expect(graph.locator('[data-graph-node][data-kind="action"]')).toHaveCount(16);
  await expect(graph.getByRole("heading",{level:3})).toHaveCount(0);
  await expect(graph.locator('[data-kind="link"], [data-kind="tool"]')).toHaveCount(0);
  for (const href of await graph.locator('[data-kind="link"] > a, [data-kind="tool"] > a').evaluateAll(nodes => nodes.map(node => node.getAttribute("href")))) expect(href?.length).toBeGreaterThan(0);
  const node = graph.locator('[data-graph-node="action:goal"]');
  await node.scrollIntoViewIfNeeded();
  const action = node.locator(":scope > button").first();
  const key = spaceFlowStorageKey(project.id, owner.userId);
  const firstLine = graph.locator('svg > path[data-kind="main"]').first();
  const beforeLine = await firstLine.getAttribute("d");
  const box = await action.boundingBox(); if (!box) throw new Error("The flow action must be visible");
  await page.mouse.move(box.x + 30, box.y + 25); await page.mouse.wheel(0, -120);
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "[]").find((point: { id: string }) => point.id === "action:goal")?.scale, key)).toBe(1.05);
  await expect(firstLine).not.toHaveAttribute("d", beforeLine!);
  const scaledLine = await firstLine.getAttribute("d");
  const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "[]").find((point: { id: string }) => point.id === "action:goal"), key);
  const movedBox = await action.boundingBox(); if (!movedBox) throw new Error("The scaled action must stay visible");
  await page.mouse.move(movedBox.x + 30, movedBox.y + 25); await page.mouse.down();
  await page.waitForTimeout(520); await page.mouse.move(movedBox.x + 90, movedBox.y + 65); await page.mouse.up();
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "[]").find((point: { id: string }) => point.id === "action:goal")?.x, key)).toBe(before.x + 60);
  await expect(firstLine).not.toHaveAttribute("d", scaledLine!);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.apiReads.filter(read => /^(POST|PUT|PATCH|DELETE) projects\//.test(read) && !read.endsWith("/space-changes/reconcile"))).toEqual([]);
  const desktop = await page.evaluate(key => localStorage.getItem(key), key);
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(graph).toHaveAttribute("data-mobile", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(desktop);
  assertIsolated(f);
});
