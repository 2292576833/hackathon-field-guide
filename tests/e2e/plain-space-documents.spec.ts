import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./ux-test.ts";
import type { FixtureIdentity, IsolatedWorkspace } from "./isolated-workspace.ts";
import type { Project } from "../../src/modules/projects/model.ts";
import type { ProjectDetail } from "../../src/components/projects-client.tsx";
import type { SpaceDocument } from "../../src/server/space-documents.ts";
import type { SpaceManualTodo } from "../../src/modules/space-workflow/todos.ts";

// The page server only supplies UI assets. ux-test intercepts every API with
// real application handlers and a migrated, owned in-memory PostgreSQL engine.
// Identities, archives and revocations below belong only to that engine.
async function space(f: IsolatedWorkspace, suffix: string) {
  const owner = await f.login(`plain-documents-${suffix}-owner@example.test`, "正文作者");
  const project = await f.request<Project>("projects", "POST", {
    name: `正文文档验收-${suffix}`, timezone: "Asia/Shanghai",
    goal: "记录真实协作正文", minimumDeliverable: "可阅读和交接的一份记录",
  }, owner, 201);
  // Isolate this component from the large process canvas and its own interactions.
  await f.request(`projects/${project.id}/space-canvas`, "PUT", { expectedRevision: 0, items: [
    { instanceId: "plain-documents", kind: "documents", x: 24, y: 24, width: 600, height: 310, scale: 1, collapsed: false },
  ] }, owner);
  return { owner, project, base: `/app/projects/${project.id}`, apiBase: `projects/${project.id}` };
}
async function join(f: IsolatedWorkspace, owner: FixtureIdentity, project: Project, suffix: string) {
  const member = await f.login(`plain-documents-${suffix}-member@example.test`, "一起写正文的队友");
  const detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
  const invitation = await f.request<{ token: string }>(`projects/${project.id}/invitations`, "POST", {
    expectedRevision: detail.project.revision, role: "member", maxUses: 1,
  }, owner, 201);
  await f.request(`invitations/${invitation.token}/accept`, "POST", {}, member);
  return member;
}
async function loaded(page: Page, base: string, name: string) {
  await page.goto(base);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const panel = page.locator("#space-documents");
  await expect(panel).toHaveCount(1);
  await expect(panel.locator("[data-space-document-body]").first()).toBeVisible();
  await expect(panel.getByText("正在读取文档…", { exact: true })).not.toBeVisible();
  return panel;
}
async function openMenu(item: Locator, label = "文档更多操作") {
  const menu = item.locator("[data-space-document-menu]");
  if (await menu.getAttribute("open") === null) await menu.getByLabel(label, { exact: true }).click();
  await expect(menu).toHaveAttribute("open", "");
  return menu;
}
async function action(item: Locator, name: string, label?: string) {
  await (await openMenu(item, label)).getByRole("button", { name, exact: true }).click();
}
async function clipboard(page: Page) {
  // Windows uses CRLF in its system clipboard; retain all other characters.
  return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
}
function assertIsolated(f: IsolatedWorkspace) {
  expect(f.externalRequests, "No request may leave the fixture's loopback origin").toEqual([]);
  expect(f.apiReads.filter(read => /^(POST|PUT|PATCH) (?:navigator\/messages|projects\/[^/]+\/(?:assistant\/messages|feasibility)(?:$|\/))/.test(read)), "Document acceptance must not invoke a model").toEqual([]);
}

test("only the bordered body is shown; creation requires explicit save and derives an internal title from the first nonempty line", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "create");
  const page = await f.page(owner, 375);
  const panel = await loaded(page, base, project.name), form = panel.locator("form");
  await expect(panel.getByRole("heading")).toHaveCount(0);
  await expect(panel.locator("input")).toHaveCount(0);
  await expect(panel.getByText(/还没有文档|新文档标题|写第一份|写设想/)).toHaveCount(0);
  await expect(panel.getByText("保存后，本空间成员可读。", { exact: true })).not.toBeVisible();
  await expect(panel.getByRole("button", { name: "刷新文档", exact: true })).not.toBeVisible();
  expect((await panel.innerText()).trim()).toBe("⋯");
  const borders = await form.locator("[data-space-document-body]").evaluate(frame => ({
    frame: getComputedStyle(frame).borderTopWidth,
    panel: getComputedStyle(frame.closest("section")!).borderTopWidth,
    editor: getComputedStyle(frame.querySelector("textarea")!).borderTopWidth,
  }));
  expect(borders).toEqual({ frame: "1px", panel: "0px", editor: "0px" });

  const firstLine = `  ${"首行内部标识".repeat(45)}  `;
  const body = `\n \n${firstLine}\n\n正文保持前后的空行。\n`;
  await form.getByLabel("新文档正文", { exact: true }).fill(body);
  await expect(form.getByText("已保护私人草稿，尚未保存到团队。", { exact: true })).toBeVisible();
  expect(await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner)).toEqual([]);
  expect(f.apiReads.filter(read => read === `POST ${apiBase}/space-documents`)).toEqual([]);
  const menu = await openMenu(form, "新文档更多操作");
  await expect(menu.getByText("私人保护不会让队友看到；点击保存后，本空间成员可读。", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open", "");
  await expect(menu.getByLabel("新文档更多操作", { exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("open", "");
  await menu.getByRole("button", { name: "保存", exact: true }).click();
  await expect(panel.getByText("正文已保存，本空间成员可以阅读。", { exact: true })).toBeVisible();
  await expect(form.getByLabel("新文档正文", { exact: true })).toHaveValue("");
  const saved = await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ title: firstLine.trim().slice(0, 200), body, authorId: owner.userId, revision: 1, teamEditable: false });
  await expect(panel.locator("[data-space-document-text]")).toHaveText(body);
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  assertIsolated(f);
});

test("a teammate selects and copies every line of long plain text; the menu adds a real private memo and shares the document position", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "long");
  const member = await join(f, owner, project, "long");
  const body = "\n" + Array.from({ length: 75 }, (_, i) => `${i + 1}. 正文记录当前真实版本、复现步骤与交接依据。`).join("\n")
    + `\n${"连续字符".repeat(100)}\n<script>这里只是文字</script>\n最后一行也必须能复制。\n`;
  const document = await f.request<SpaceDocument>(`${apiBase}/space-documents`, "POST", { title: "隐藏的历史标题", body }, owner, 201);
  const page = await f.page(member, 375);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: f.origin });
  await loaded(page, base, project.name);
  const item = page.locator(`#space-document-${document.id}`), text = item.locator("[data-space-document-text]");
  expect(await text.textContent()).toBe(body);
  await expect(item.getByText(document.title, { exact: true })).toHaveCount(0);
  await expect(text.locator("script")).toHaveCount(0);
  const selection = await text.evaluate(element => {
    const range = window.document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    const style = getComputedStyle(element);
    return { text: selection?.toString(), userSelect: style.userSelect, overflowY: style.overflowY,
      clipped: element.scrollHeight > element.clientHeight + 1, border: style.borderTopWidth };
  });
  // Chromium's rendered selection omits the final paragraph delimiter. The
  // direct body copy below must still preserve that exact terminal newline.
  expect(selection).toEqual({ text: body.replace(/\n$/, ""), userSelect: "text", overflowY: "visible", clipped: false, border: "0px" });
  const menu = await openMenu(item);
  for (const name of ["编辑", "允许队友编辑", "删除文档"]) await expect(menu.getByRole("button", { name, exact: true })).toHaveCount(0);
  await menu.getByRole("button", { name: "复制正文", exact: true }).click();
  await expect(page.getByText("已复制完整正文。", { exact: true })).toBeVisible();
  expect(await clipboard(page)).toBe(body);

  await page.evaluate(() => window.addEventListener("hackathon:space-todos-changed", event => {
    sessionStorage.setItem("plain-document-todo-event", (event as CustomEvent<{ projectId: string }>).detail.projectId);
  }));
  await action(item, "加入私人备忘");
  await expect(page.getByText("已加入私人备忘，只有你可见。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("plain-document-todo-event"))).toBe(project.id);
  const mine = await f.request<SpaceManualTodo[]>(`${apiBase}/space-todos`, "GET", undefined, member);
  expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ title: `阅读：${document.title}`, status: "open" });
  expect(mine[0]!.note).toContain(`#space-document-${document.id}`);
  expect(await f.request<SpaceManualTodo[]>(`${apiBase}/space-todos`, "GET", undefined, owner)).toEqual([]);
  await action(item, "复制文档位置");
  expect(await clipboard(page)).toBe(`${f.origin}${base}#space-document-${document.id}`);
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  const destination = await f.page(owner, 375);
  await destination.goto(`${base}#space-document-${document.id}`);
  const linked = destination.locator(`#space-document-${document.id}`);
  await expect(linked.locator("[data-space-document-text]")).toHaveText(body);
  await expect.poll(() => linked.evaluate(element => {
    const box = element.getBoundingClientRect(); return box.top >= -2 && box.top < innerHeight / 2;
  })).toBeTruthy();
  assertIsolated(f);
});

test("only author-granted teammate editing persists; long editors grow, existing titles stay internal and withdrawing permission restores read-only", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "shared");
  const member = await join(f, owner, project, "shared");
  const document = await f.request<SpaceDocument>(`${apiBase}/space-documents`, "POST", { title: "保留的内部标识", body: "作者原始正文" }, owner, 201);
  const ownerPage = await f.page(owner), memberPage = await f.page(member, 375);
  await loaded(ownerPage, base, project.name); await loaded(memberPage, base, project.name);
  const ownerItem = ownerPage.locator(`#space-document-${document.id}`), memberItem = memberPage.locator(`#space-document-${document.id}`);
  await expect((await openMenu(memberItem)).getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
  const denied = await f.raw(`${apiBase}/space-documents/${document.id}/edit`, "POST", { expectedRevision: 1, body: "不应写入" }, member);
  expect(denied.status).toBe(403);
  await action(ownerItem, "允许队友编辑");
  await expect(ownerPage.getByText("已允许队友编辑。", { exact: true })).toBeVisible();
  await action(memberItem, "刷新文档");
  await action(memberItem, "编辑");
  const body = Array.from({ length: 90 }, (_, i) => `${i + 1}. 队友补充的复现步骤，保存前只留在本页草稿。`).join("\n") + "\n\n";
  const editor = memberItem.getByLabel("正文", { exact: true });
  await editor.fill(body);
  await expect.poll(() => editor.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  expect(await editor.evaluate(element => element.clientHeight)).toBeGreaterThan(180);
  expect((await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner))[0]!.body).toBe(document.body);
  const editMenu = await openMenu(memberItem);
  await expect(editMenu.getByText("私人保护不会让队友看到；点击保存后，本空间成员可读。", { exact: true })).toBeVisible();
  await expect(editMenu.getByRole("button", { name: "允许队友编辑", exact: true })).toHaveCount(0);
  await expect(editMenu.getByRole("button", { name: "删除文档", exact: true })).toHaveCount(0);
  await editMenu.getByRole("button", { name: "保存", exact: true }).click();
  await expect(memberItem.locator("[data-space-document-text]")).toHaveText(body);
  const saved = (await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner))[0]!;
  expect(saved).toMatchObject({ body, title: document.title, authorId: owner.userId, teamEditable: true, revision: 3 });
  await action(ownerItem, "刷新文档");
  await expect(ownerItem.locator("[data-space-document-text]")).toHaveText(body);
  await action(ownerItem, "收回队友编辑");
  await expect(ownerPage.getByText("已收回队友编辑权限，队友仍可阅读。", { exact: true })).toBeVisible();
  await action(memberItem, "刷新文档");
  await expect((await openMenu(memberItem)).getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
  expect((await f.raw(`${apiBase}/space-documents/${document.id}/edit`, "POST", { expectedRevision: 4, body: "收回后不应写入" }, member)).status).toBe(403);
  expect((await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner))[0]!.body).toBe(body);
  await action(ownerItem, "删除文档");
  await expect(ownerPage.getByText("已删除这份文档。", { exact: true })).toBeVisible();
  expect(await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner)).toEqual([]);
  assertIsolated(f);
});

test("409 leaves the complete draft copyable and disables stale saves until the user explicitly reads the latest saved body", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "conflict");
  const document = await f.request<SpaceDocument>(`${apiBase}/space-documents`, "POST", { title: "内部标识", body: "旧正文" }, owner, 201);
  const page = await f.page(owner);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: f.origin });
  const panel = await loaded(page, base, project.name), item = page.locator(`#space-document-${document.id}`);
  await action(item, "编辑");
  const draft = `\n${"冲突也不能丢失的草稿。\n".repeat(100)}\n`;
  await item.getByLabel("正文", { exact: true }).fill(draft);
  const winner = "另一窗口已经保存的新正文。";
  await f.request(`${apiBase}/space-documents/${document.id}/edit`, "POST", { expectedRevision: 1, body: winner }, owner);
  const response = page.waitForResponse(response => response.url().endsWith(`/document-drafts/${document.id}/publish`) && response.request().method() === "POST");
  await action(item, "保存");
  const rejected = await (await response).json();
  expect(rejected.data.receipt.status).toBe("failed"); expect(rejected.data.receipt.errorCode).toBe("VERSION_CONFLICT");
  await expect(item.getByRole("alert").filter({ hasText: "私稿仍保留" })).toBeVisible();
  expect((await f.request<{ body: string | null }>(`${apiBase}/document-drafts/${document.id}`, "GET", undefined, owner)).body).toBe(draft);
  await expect(item.getByLabel("正文", { exact: true })).toHaveValue(draft);
  await expect(panel.getByText("正文已保存，本空间成员可以阅读。", { exact: true })).toHaveCount(0);
  await expect((await openMenu(item)).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await action(item, "复制草稿正文"); expect(await clipboard(page)).toBe(draft);
  expect((await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner))[0]).toMatchObject({ body: winner, revision: 2 });
  await action(item, "放弃草稿，读取已保存正文");
  await expect(item.locator("[data-space-document-text]")).toHaveText(winner);
  assertIsolated(f);
});

test("an archived space keeps copyable body and location in its menu, with every document write rejected by the real handler", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "archived");
  const document = await f.request<SpaceDocument>(`${apiBase}/space-documents`, "POST", { title: "历史标识", body: "归档后仍可完整阅读。\n保留全部正文。" }, owner, 201);
  const detail = await f.request<ProjectDetail>(apiBase, "GET", undefined, owner);
  await f.request(`${apiBase}/stage`, "POST", { expectedRevision: detail.project.revision, stage: "archived", reason: "正文归档隔离验收" }, owner);
  const page = await f.page(owner, 375);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: f.origin });
  const panel = await loaded(page, base, project.name), item = page.locator(`#space-document-${document.id}`);
  await expect(panel.getByText("空间已归档，文档只读。", { exact: true })).toBeVisible();
  await expect(panel.locator("textarea")).toHaveCount(0);
  expect(await item.locator("[data-space-document-text]").textContent()).toBe(document.body);
  const menu = await openMenu(item);
  for (const name of ["保存", "编辑", "允许队友编辑", "收回队友编辑", "删除文档", "加入私人备忘"]) await expect(menu.getByRole("button", { name, exact: true })).toHaveCount(0);
  await menu.getByRole("button", { name: "复制正文", exact: true }).click();
  expect(await clipboard(page)).toBe(document.body);
  await action(item, "复制文档位置"); expect(await clipboard(page)).toBe(`${f.origin}${base}#space-document-${document.id}`);
  expect(f.apiReads.filter(read => /^(POST|PUT|PATCH|DELETE) projects\/[^/]+\/space-(?:documents|todos)(?:$|\/)/.test(read))).toEqual([]);
  for (const [path, payload] of [
    [`${apiBase}/space-documents`, { title: "归档新建", body: "不应写入" }],
    [`${apiBase}/space-documents/${document.id}/edit`, { expectedRevision: 1, body: "归档编辑" }],
    [`${apiBase}/space-documents/${document.id}/share`, { expectedRevision: 1, teamEditable: true }],
    [`${apiBase}/space-documents/${document.id}/remove`, {}],
  ] as const) {
    const response = await f.raw(path, "POST", payload, owner);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("PROJECT_ARCHIVED");
  }
  expect(await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner)).toEqual([document]);
  assertIsolated(f);
});

test("archiving while an old page is editing preserves both new and existing drafts without reporting save success", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "archive-race");
  const document = await f.request<SpaceDocument>(`${apiBase}/space-documents`, "POST", { title: "历史标识", body: "已保存正文" }, owner, 201);
  const page = await f.page(owner);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: f.origin });
  const panel = await loaded(page, base, project.name), item = page.locator(`#space-document-${document.id}`), form = panel.locator("form");
  await action(item, "编辑");
  await item.getByLabel("正文", { exact: true }).fill("归档前没保存的编辑草稿。\n完整保留。");
  await form.getByLabel("新文档正文", { exact: true }).fill("归档前没保存的新正文。\n也完整保留。");
  const detail = await f.request<ProjectDetail>(apiBase, "GET", undefined, owner);
  await f.request(`${apiBase}/stage`, "POST", { expectedRevision: detail.project.revision, stage: "archived", reason: "旧页面保存隔离验收" }, owner);
  await action(item, "保存");
  await expect(panel.getByText("空间已归档，文档只读。", { exact: true })).toBeVisible();
  await expect(item.getByLabel("正文", { exact: true })).toHaveValue("归档前没保存的编辑草稿。\n完整保留。");
  await expect(item.getByLabel("正文", { exact: true })).toHaveAttribute("readonly", "");
  await expect(form.getByLabel("新文档正文", { exact: true })).toHaveValue("归档前没保存的新正文。\n也完整保留。");
  await expect(form.getByLabel("新文档正文", { exact: true })).toHaveAttribute("readonly", "");
  await expect(panel.getByText("正文已保存，本空间成员可以阅读。", { exact: true })).toHaveCount(0);
  await expect((await openMenu(item)).getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await action(item, "复制草稿正文"); expect(await clipboard(page)).toBe("归档前没保存的编辑草稿。\n完整保留。");
  await expect((await openMenu(form, "新文档更多操作")).getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await action(form, "复制草稿正文", "新文档更多操作"); expect(await clipboard(page)).toBe("归档前没保存的新正文。\n也完整保留。");
  expect(await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner)).toEqual([document]);
  assertIsolated(f);
});

test("revoking the current member hides old inputs and rejects follow-up private and shared reads", async ({ workspace: f }) => {
  const { owner, project, base, apiBase } = await space(f, "member-race");
  const member = await join(f, owner, project, "member-race");
  const document = await f.request<SpaceDocument>(`${apiBase}/space-documents`, "POST", { title: "原标识", body: "真实保存正文" }, owner, 201);
  await f.request(`${apiBase}/space-documents/${document.id}/share`, "POST", { expectedRevision: 1, teamEditable: true }, owner);
  const page = await f.page(member);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: f.origin });
  const panel = await loaded(page, base, project.name), item = page.locator(`#space-document-${document.id}`);
  await action(item, "编辑"); await item.getByLabel("正文", { exact: true }).fill("本人尚未保存的草稿。\n成员撤销后仍可复制。");
  // Use the real membership operation in the owned fixture, including its
  // departure timestamp and facts revision, rather than an invalid SQL row.
  const current = await f.request<ProjectDetail>(apiBase, "GET", undefined, owner);
  await f.request(`${apiBase}/members/${member.userId}`, "DELETE", { expectedRevision: current.project.revision }, owner);
  await action(item, "保存");
  await expect(panel.getByLabel("正文", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("正文已保存，本空间成员可以阅读。", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await expect(item).toHaveCount(0);
  expect((await f.raw(`${apiBase}/space-documents`, "GET", undefined, member)).status).toBe(403);
  expect((await f.raw(`${apiBase}/document-drafts`, "GET", undefined, member)).status).toBe(403);
  expect((await f.request<SpaceDocument[]>(`${apiBase}/space-documents`, "GET", undefined, owner))[0]).toMatchObject({ body: document.body, revision: 2, teamEditable: true });
  assertIsolated(f);
});
