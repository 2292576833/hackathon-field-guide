import { expect, test, type Locator, type Page } from "@playwright/test";
import jsQR from "jsqr";
import type { Project, ProjectMember, PublicInvitation, PublicSpaceInvitationPreview } from "../../src/modules/projects/model.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

interface ProjectDetail { project: Project; membership: ProjectMember; members: ProjectMember[] }
interface IssuedInvitation { invitation: PublicInvitation; token: string; projectRevision: number }

// Every account, invitation, challenge email and database row belongs to this
// fixture. The page server only renders UI; API routes use isolatedWorkspace.
// No screenshots or browser traces are saved with invitation tokens.
test.use({ screenshot: "off", video: "off", trace: "off" });

async function createSpace(f: IsolatedWorkspace, owner: FixtureIdentity) {
  return f.request<Project>("projects", "POST", {
    name: "邀请队友一起完成演示作品", timezone: "Asia/Shanghai", goal: "完成新人可以使用的参赛作品",
    minimumDeliverable: "一条可操作的网页流程", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
  }, owner, 201);
}

async function issue(f: IsolatedWorkspace, owner: FixtureIdentity, projectId: string, maxUses = 1, invitedEmail?: string) {
  const detail = await f.request<ProjectDetail>(`projects/${projectId}`, "GET", undefined, owner);
  return f.request<IssuedInvitation>(`projects/${projectId}/invitations`, "POST", {
    expectedRevision: detail.project.revision, role: "member", maxUses, ...(invitedEmail ? { invitedEmail } : {}),
  }, owner, 201);
}

function invitationDialog(page: Page) {
  return page.getByRole("dialog", { name: "邀请队友加入团队空间", exact: true });
}

async function openInvitation(page: Page) {
  const trigger = page.getByRole("button", { name: "邀请队友", exact: true });
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  const dialog = invitationDialog(page);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.tagName === "DIALOG" && (element as HTMLDialogElement).open), "Invitation must use an open native dialog").toBeTruthy();
  return dialog;
}

async function generate(page: Page, projectId: string, buttonName = "生成邀请链接") {
  const dialog = invitationDialog(page);
  const responsePromise = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/invitations`);
  await dialog.getByRole("button", { name: buttonName, exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), "Fixture invitation creation must succeed").toBe(201);
  const { data } = await response.json() as { data: IssuedInvitation };
  expect(typeof data.invitation.id, "Creation response must include the real invitation ID").toBe("string");
  expect(data.invitation.id.length).toBeGreaterThan(0);
  expect(data.invitation.role).toBe("member");
  expect(Object.hasOwn(data.invitation, "tokenHash")).toBe(false);
  expect(Object.hasOwn(data.invitation, "acceptances")).toBe(false);
  const link = dialog.getByLabel("本次邀请链接", { exact: true });
  await expect(link).toHaveValue(/\/app\/join\//);
  await expect(dialog.getByRole("button", { name: "复制邀请链接", exact: true })).toBeEnabled();
  const value = await link.inputValue();
  expect(new URL(value).pathname === `/app/join/${encodeURIComponent(data.token)}`, "Displayed link must use the token from the fixture response").toBeTruthy();
  return { ...data, link: value };
}

async function verifyLocalQr(dialog: Locator, expectedLink: string) {
  const disclosure = dialog.locator("summary").filter({ hasText: /^展示同一链接的二维码$/ }).locator("..");
  if (!(await disclosure.evaluate(element => (element as HTMLDetailsElement).open))) await disclosure.locator("summary").click();
  const qr = dialog.getByRole("img", { name: "扫码打开团队空间邀请", exact: true });
  await expect(qr).toBeVisible();
  const bitmap = await qr.evaluate(svg => {
    const size = Number(svg.getAttribute("viewBox")!.split(" ")[2]), scale = 4, width = size * scale;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    for (const cell of svg.querySelector("path")!.getAttribute("d")!.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
      for (let y = Number(cell[2]) * scale; y < (Number(cell[2]) + 1) * scale; y++) {
        for (let x = Number(cell[1]) * scale; x < (Number(cell[1]) + 1) * scale; x++) {
          const index = (y * width + x) * 4;
          pixels[index] = pixels[index + 1] = pixels[index + 2] = 17;
        }
      }
    }
    return { pixels: [...pixels], width };
  });
  const decoded = jsQR(new Uint8ClampedArray(bitmap.pixels), bitmap.width, bitmap.width);
  expect(Boolean(decoded && decoded.data === expectedLink), "Local QR must encode exactly the displayed fixture invitation URL").toBeTruthy();
}

function verifyIsolation(f: IsolatedWorkspace) {
  expect(f.externalRequests).toEqual([]);
  expect(f.apiReads.filter(value => value.startsWith("POST ") && /generation|navigator\/messages|roadshow|ppt|github/.test(value))).toEqual([]);
}

async function verifyMobile(page: Page, dialog?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "375px page must not overflow horizontally").toBeTruthy();
  if (dialog) expect(await dialog.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= -1 && bounds.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
  }), "Dialog content must fit the phone viewport and scroll vertically when needed").toBeTruthy();
}

test("native phone invitation dialog defaults to one member, copies its local QR link, and retains it across both close paths", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-default-owner@example.test", "邀请人"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (value: string) => { (window as Window & { fixtureCopiedInvite?: string }).fixtureCopiedInvite = value; },
      } });
    });
    await page.goto(`/app/projects/${project.id}/team`);
    const dialog = await openInvitation(page);
    await expect(dialog.getByRole("button", { name: "1 人", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByLabel("自定义人数（1–50）", { exact: true })).toBeHidden();
    await expect(dialog.getByLabel("限定队友邮箱（选填）", { exact: true })).toBeHidden();
    for (const summary of ["自定义人数", "更多设置", "邀请记录"]) {
      await expect(dialog.locator("summary").filter({ hasText: new RegExp(`^${summary}$`) }).locator("..")).not.toHaveAttribute("open", "");
    }
    const issued = await generate(page, project.id);
    expect(issued.invitation.maxUses).toBe(1);
    expect(issued.invitation.remainingUses).toBe(1);
    expect(Date.parse(issued.invitation.expiresAt) - Date.parse(issued.invitation.createdAt)).toBe(72 * 60 * 60_000);
    await verifyLocalQr(dialog, issued.link);
    await dialog.getByRole("button", { name: "复制邀请链接", exact: true }).click();
    expect(await page.evaluate(value => (window as Window & { fixtureCopiedInvite?: string }).fixtureCopiedInvite === value, issued.link), "Copy action must copy this invitation").toBeTruthy();
    await expect(dialog.getByText(/及时复制|离开.*页面|离页/).first()).toBeVisible();
    expect(await page.evaluate(value => ![...Object.values(localStorage), ...Object.values(sessionStorage)].some(item => item.includes(value)), issued.token), "Invitation token must not be saved in persistent browser storage").toBeTruthy();
    await verifyMobile(page, dialog);

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toBeFocused();
    await openInvitation(page);
    expect(await dialog.getByLabel("本次邀请链接", { exact: true }).inputValue() === issued.link, "Escape must retain the current invitation").toBeTruthy();
    await dialog.getByRole("button", { name: /^关闭/ }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toBeFocused();
    await openInvitation(page);
    expect(await dialog.getByLabel("本次邀请链接", { exact: true }).inputValue() === issued.link, "Close button must retain the current invitation").toBeTruthy();
    expect((await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner))).toHaveLength(1);
    verifyIsolation(f);
  } finally { await f.close(); }
});

test("custom counts are optional and revoking an older invitation preserves the latest link and QR", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-history-owner@example.test", "管理员"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375);
    await page.goto(`/app/projects/${project.id}/team`);
    const dialog = await openInvitation(page);
    await dialog.getByRole("button", { name: "3 人", exact: true }).click();
    const old = await generate(page, project.id);
    expect(old.invitation.maxUses).toBe(3);
    await dialog.getByRole("button", { name: "5 人", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "5 人", exact: true })).toHaveAttribute("aria-pressed", "true");
    await dialog.locator("summary").filter({ hasText: /^自定义人数$/ }).click();
    const beforeInvalid = f.apiReads.filter(value => value === `POST projects/${project.id}/invitations`).length;
    for (const invalid of ["51", "1.5", "0"]) {
      await dialog.getByLabel("自定义人数（1–50）", { exact: true }).fill(invalid);
      await dialog.getByRole("button", { name: "生成另一条邀请", exact: true }).click();
      await expect(dialog.getByText("邀请人数需为 1–50 的整数。", { exact: true })).toBeVisible();
      expect(f.apiReads.filter(value => value === `POST projects/${project.id}/invitations`).length, "Invalid quota must not send a creation request").toBe(beforeInvalid);
    }
    await dialog.getByLabel("自定义人数（1–50）", { exact: true }).fill("7");
    await dialog.locator("summary").filter({ hasText: /^更多设置$/ }).click();
    await dialog.getByLabel("限定队友邮箱（选填）", { exact: true }).fill("t01-custom-target@example.test");
    const current = await generate(page, project.id, "生成另一条邀请");
    expect(current.invitation.maxUses).toBe(7);
    expect(current.invitation.invitedEmail).toBe("t01-custom-target@example.test");
    await expect(dialog.getByLabel("限定队友邮箱（选填）", { exact: true })).toHaveValue("");
    expect(current.invitation.id !== old.invitation.id, "New invitation must have a distinct persisted ID").toBeTruthy();
    await dialog.locator("summary").filter({ hasText: /^邀请记录$/ }).click();
    const oldRow = dialog.getByRole("listitem").filter({ hasText: /最多\s*3\s*人/ });
    await expect(oldRow).toHaveCount(1);
    const revokedResponse = page.waitForResponse(response => response.request().method() === "DELETE"
      && new URL(response.url()).pathname === `/api/v1/projects/${project.id}/invitations/${old.invitation.id}`);
    await oldRow.getByRole("button", { name: "撤销这条邀请", exact: true }).click();
    expect((await revokedResponse).status()).toBe(200);
    await expect(oldRow).toContainText("已撤销");
    expect(await dialog.getByLabel("本次邀请链接", { exact: true }).inputValue() === current.link, "Revoking an old record must not clear the new link").toBeTruthy();
    await verifyLocalQr(dialog, current.link);
    const saved = await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner);
    expect(saved.find(item => item.id === old.invitation.id)?.displayStatus).toBe("revoked");
    expect(saved.find(item => item.id === current.invitation.id)?.displayStatus).toBe("pending");

    const currentRow = dialog.getByRole("listitem").filter({ hasText: /最多\s*7\s*人/ });
    await currentRow.getByRole("button", { name: "撤销这条邀请", exact: true }).click();
    await expect(currentRow).toContainText("已撤销");
    await expect(dialog.getByLabel("本次邀请链接", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "复制邀请链接", exact: true })).toHaveCount(0);
    await verifyMobile(page, dialog);
    verifyIsolation(f);
  } finally { await f.close(); }
});

test("clipboard refusal leaves a selectable invitation and does not create another invitation", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-copy-owner@example.test", "管理员"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async () => { throw new DOMException("Fixture clipboard denied", "NotAllowedError"); },
      } });
    });
    await page.goto(`/app/projects/${project.id}/team`);
    const dialog = await openInvitation(page), issued = await generate(page, project.id);
    await dialog.getByRole("button", { name: "复制邀请链接", exact: true }).click();
    await expect(dialog.getByText("复制失败，请选中下方链接手动复制。", { exact: true })).toBeVisible();
    const link = dialog.getByLabel("本次邀请链接", { exact: true });
    expect(await link.inputValue() === issued.link, "Copy failure must preserve the invitation URL").toBeTruthy();
    await link.focus();
    expect(await link.evaluate(element => {
      const input = element as HTMLInputElement;
      return input.readOnly && input.selectionStart === 0 && input.selectionEnd === input.value.length;
    }), "Manual-copy fallback must select the retained link").toBeTruthy();
    expect((await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner))).toHaveLength(1);
    verifyIsolation(f);
  } finally { await f.close(); }
});

test("a missing invitation list clears the retained token and disables further invitation actions", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-access-owner@example.test", "管理员"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375);
    await page.goto(`/app/projects/${project.id}/team`);
    const dialog = await openInvitation(page);
    await generate(page, project.id);
    await page.route(`**/api/v1/projects/${project.id}/invitations`, async route => {
      if (route.request().method() !== "GET") { await route.fallback(); return; }
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({
        error: { code: "PROJECT_NOT_FOUND", message: "邀请记录已不可访问（隔离夹具）。" },
      }) });
    });
    await dialog.locator("summary").filter({ hasText: /^邀请记录$/ }).click();
    await dialog.getByRole("button", { name: "读取最新邀请状态", exact: true }).click();
    await expect(dialog.getByText("本页链接已清除、邀请操作已停用", { exact: false })).toBeVisible();
    await expect(dialog.getByLabel("本次邀请链接", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "复制邀请链接", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "生成邀请链接", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "撤销这条邀请", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await openInvitation(page);
    await expect(dialog.getByLabel("本次邀请链接", { exact: true })).toHaveCount(0);
    expect((await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner))).toHaveLength(1);
    verifyIsolation(f);
  } finally { await f.close(); }
});

test("a saved invitation with a lost creation response is checked and revoked before an explicit new link is generated", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-create-unknown-owner@example.test", "管理员"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375);
    let creationPosts = 0;
    await page.route("**/api/v1/projects/*/invitations", async route => {
      if (route.request().method() !== "POST") { await route.fallback(); return; }
      creationPosts++;
      // Persist using the actual handler and this browser form's request body,
      // then simulate an unreadable transport result without touching the host.
      const saved = await f.raw(`projects/${project.id}/invitations`, "POST", route.request().postDataJSON(), owner);
      expect(saved.status).toBe(201);
      await route.abort("failed");
    });
    await page.goto(`/app/projects/${project.id}/team`);
    const dialog = await openInvitation(page);
    await dialog.getByRole("button", { name: "生成邀请链接", exact: true }).click();
    await expect(dialog.getByText("刚才的生成结果尚未确认。", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "已核对记录，生成新邀请", exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("本次邀请链接", { exact: true })).toHaveCount(0);
    let invitations = await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner);
    expect(invitations).toHaveLength(1);
    expect(creationPosts, "Unknown creation must not be replayed automatically").toBe(1);
    await dialog.getByRole("button", { name: "核对刚才的邀请记录", exact: true }).click();
    await expect(dialog.getByText("已读取邀请记录。", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "已核对记录，生成新邀请", exact: true })).toBeEnabled();
    await expect(dialog.getByLabel("本次邀请链接", { exact: true })).toHaveCount(0);
    expect(creationPosts, "Reading history must not recreate an invitation").toBe(1);
    const record = dialog.getByRole("listitem");
    await expect(record).toHaveCount(1);
    await record.getByRole("button", { name: "撤销这条邀请", exact: true }).click();
    await expect(record).toContainText("已撤销");
    await page.unroute("**/api/v1/projects/*/invitations");
    const issued = await generate(page, project.id, "已核对记录，生成新邀请");
    invitations = await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner);
    expect(invitations).toHaveLength(2);
    expect(invitations.filter(item => item.displayStatus === "revoked")).toHaveLength(1);
    expect(invitations.find(item => item.id === issued.invitation.id)?.displayStatus).toBe("pending");
    await verifyMobile(page, dialog);
    verifyIsolation(f);
  } finally { await f.close(); }
});

test("every space page has one invitation trigger and the legacy team anchor opens the same dialog", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-routes-owner@example.test", "管理员"), project = await createSpace(f, owner);
    const page = await f.page(owner);
    for (const suffix of ["", "/team", "/assessment", "/plan", "/rules", "/resources", "/delivery", "/retrospective"]) {
      await page.goto(`/app/projects/${project.id}${suffix}`);
      const dialog = await openInvitation(page);
      await expect(page.locator("#space-invitation")).toHaveCount(1);
      await expect(dialog.getByRole("button", { name: "生成邀请链接", exact: true })).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(`/app/projects/${project.id}/team#space-invitation`);
    await expect(invitationDialog(page)).toBeVisible();
    await expect(page.locator("#space-invitation")).toHaveCount(1);
    expect((await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner))).toHaveLength(0);
    await verifyMobile(page, invitationDialog(page));
    verifyIsolation(f);
  } finally { await f.close(); }
});

test("members and archived spaces explain invitation permissions and cannot create invitations", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-permission-owner@example.test", "管理员"), member = await f.login("t01-permission-member@example.test", "普通队友");
    const project = await createSpace(f, owner), joining = await issue(f, owner, project.id), pending = await issue(f, owner, project.id);
    await f.request(`invitations/${joining.token}/accept`, "POST", {}, member);
    const memberPage = await f.page(member, 375);
    await memberPage.goto(`/app/projects/${project.id}/team#space-invitation`);
    await expect(memberPage.getByRole("button", { name: "邀请队友", exact: true })).toHaveCount(0);
    await expect(invitationDialog(memberPage)).not.toBeVisible();
    await expect(memberPage.getByText(/管理员.*邀请|邀请.*管理员/).first()).toBeVisible();
    let detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
    await f.request(`projects/${project.id}/invitations`, "POST", { expectedRevision: detail.project.revision, role: "member", maxUses: 1 }, member, 403);
    await f.request(`projects/${project.id}/invitations/${pending.invitation.id}`, "DELETE", { expectedRevision: detail.project.revision }, member, 403);
    await f.request(`projects/${project.id}/stage`, "POST", { expectedRevision: detail.project.revision, stage: "archived", reason: "邀请只读验收" }, owner);
    detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
    const archivedPage = await f.page(owner, 375);
    await archivedPage.goto(`/app/projects/${project.id}/team#space-invitation`);
    await expect(archivedPage.getByRole("button", { name: "邀请队友", exact: true })).toHaveCount(0);
    await expect(invitationDialog(archivedPage)).not.toBeVisible();
    await expect(archivedPage.getByText(/归档.*只读|归档.*邀请/).first()).toBeVisible();
    await f.request(`projects/${project.id}/invitations`, "POST", { expectedRevision: detail.project.revision, role: "member", maxUses: 1 }, owner, 409);
    expect((await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner))).toHaveLength(2);
    await verifyMobile(memberPage); await verifyMobile(archivedPage);
    verifyIsolation(f);
  } finally { await f.close(); }
});

test("joining requires a deliberate acceptance and then offers time, duties and space entry without consuming another quota", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-join-owner@example.test", "管理员"), member = await f.login("t01-join-member@example.test", "新队友");
    const project = await createSpace(f, owner), issued = await issue(f, owner, project.id, 2), joinPath = `/app/join/${issued.token}`;
    const guest = await f.page(undefined, 375);
    await guest.goto(joinPath);
    await expect(guest.getByRole("heading", { name: project.name, exact: true })).toHaveCount(1);
    await expect(guest.getByRole("link", { name: "登录后继续核对邀请", exact: true })).toHaveAttribute("href", `/login?returnTo=${encodeURIComponent(joinPath)}`);
    await expect(guest.getByRole("link", { name: "注册账号后回到此邀请", exact: true })).toHaveAttribute("href", `/register?returnTo=${encodeURIComponent(joinPath)}`);
    await expect(guest.getByRole("button", { name: "加入团队空间", exact: true })).toHaveCount(0);
    const publicResponse = await f.raw(`invitations/${issued.token}/public-preview`);
    expect(publicResponse.headers.get("cache-control")).toContain("no-store");
    const { data: publicPreview } = await publicResponse.json() as { data: PublicSpaceInvitationPreview };
    for (const field of ["scopeId", "invitedEmail", "members", "goal", "tokenHash", "acceptances"]) expect(Object.hasOwn(publicPreview, field)).toBe(false);

    const page = await f.page(member, 375);
    await page.goto(joinPath);
    await expect(page.getByRole("heading", { name: project.name, exact: true })).toHaveCount(1);
    const accept = page.getByRole("button", { name: "加入团队空间", exact: true });
    await expect(accept).toBeDisabled();
    await f.request(`projects/${project.id}`, "GET", undefined, member, 404);
    await page.getByLabel("我已核对目标与角色，明确接受这条邀请。", { exact: true }).check();
    await accept.click();
    await expect(page.getByRole("link", { name: "进入团队空间", exact: true })).toHaveAttribute("href", `/app/projects/${project.id}`);
    await expect(page.getByRole("link").filter({ hasText: /填写.*时间/ })).toHaveAttribute("href", `/app/projects/${project.id}/team`);
    await expect(page.getByRole("link", { name: "选择本人职责", exact: true })).toHaveAttribute("href", `/app/projects/${project.id}/assessment`);
    expect((await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, member)).membership.role).toBe("member");
    await f.request(`invitations/${issued.token}/accept`, "POST", {}, member);
    const invitations = await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner);
    expect(invitations.find(item => item.id === issued.invitation.id)?.usedUses).toBe(1);
    expect((await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner)).members).toHaveLength(2);
    await page.reload();
    await expect(page.getByRole("link", { name: "进入团队空间", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "加入团队空间", exact: true })).toHaveCount(0);
    const latest = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
    await f.request(`projects/${project.id}/members/${member.userId}`, "DELETE", { expectedRevision: latest.project.revision }, owner);
    const postsBeforeRecheck = f.apiReads.filter(value => value === "POST invitations/[token]/accept").length;
    await page.getByRole("button", { name: "重新核对邀请与加入结果", exact: true }).click();
    await expect(page.getByText("你已离开，原邀请不能再次加入；请索取新的邀请。", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "进入团队空间", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "填写本人可用时间", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "选择本人职责", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "加入团队空间", exact: true })).toHaveCount(0);
    expect(f.apiReads.filter(value => value === "POST invitations/[token]/accept").length, "Removed membership must be checked without replaying acceptance").toBe(postsBeforeRecheck);
    await f.request(`projects/${project.id}`, "GET", undefined, member, 404);
    await f.request(`invitations/${issued.token}/accept`, "POST", {}, member, 409);
    expect((await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner)).find(item => item.id === issued.invitation.id)?.usedUses).toBe(1);
    await verifyMobile(page); await verifyMobile(guest);
    verifyIsolation(f);
  } finally { await f.close(); }
});

test("a saved acceptance with a lost response is reconciled before another acceptance can be sent", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-unknown-owner@example.test", "管理员"), member = await f.login("t01-unknown-member@example.test", "队友");
    const project = await createSpace(f, owner), issued = await issue(f, owner, project.id, 2);
    const page = await f.page(member, 375);
    let acceptancePosts = 0;
    await page.route("**/api/v1/invitations/*/accept", async route => {
      acceptancePosts++;
      // The fixture commits the real transaction, then deliberately loses its
      // browser response. The server running on the page origin is untouched.
      const saved = await f.raw(`invitations/${issued.token}/accept`, "POST", {}, member);
      expect(saved.ok, "Fixture acceptance must be saved before simulating response loss").toBeTruthy();
      await route.abort("failed");
    });
    await page.goto(`/app/join/${issued.token}`);
    await page.getByLabel("我已核对目标与角色，明确接受这条邀请。", { exact: true }).check();
    await page.getByRole("button", { name: "加入团队空间", exact: true }).click();
    await expect(page.getByText("接受结果尚未确认", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "加入团队空间", exact: true })).toBeDisabled();
    await expect(page.getByLabel("我已核对目标与角色，明确接受这条邀请。", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "重新核对邀请与加入结果", exact: true }).click();
    await expect(page.getByRole("link", { name: "进入团队空间", exact: true })).toBeVisible();
    await expect(page.getByText("接受结果尚未确认", { exact: false })).toHaveCount(0);
    expect(acceptancePosts, "Outcome recovery must read the saved result without replaying acceptance").toBe(1);
    const invitations = await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner);
    expect(invitations.find(item => item.id === issued.invitation.id)?.usedUses).toBe(1);
    verifyIsolation(f);
  } finally { await f.close(); }
});

test("email restrictions and revoked, expired or exhausted links remain explicit and keep private recipient data hidden", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("t01-status-owner@example.test", "管理员"), intended = await f.login("t01-status-intended@example.test", "指定队友"), other = await f.login("t01-status-other@example.test", "其他账号");
    const project = await createSpace(f, owner), restricted = await issue(f, owner, project.id, 1, intended.email);
    const page = await f.page(other, 375);
    await page.goto(`/app/join/${restricted.token}`);
    await expect(page.getByText("需要使用邀请人限定的已验证邮箱。", { exact: false })).toBeVisible();
    await expect(page.getByText(intended.email, { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "加入团队空间", exact: true })).toHaveCount(0);
    await f.request(`invitations/${restricted.token}/accept`, "POST", {}, other, 403);

    const revoked = await issue(f, owner, project.id);
    const detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
    await f.request(`projects/${project.id}/invitations/${revoked.invitation.id}`, "DELETE", { expectedRevision: detail.project.revision }, owner);
    const expired = await issue(f, owner, project.id);
    await f.database.query("UPDATE projects_invitation SET expires_at=$1,created_at=$2 WHERE id=$3", [
      new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 72 * 60 * 60_000).toISOString(), expired.invitation.id,
    ]);
    const exhausted = await issue(f, owner, project.id);
    await f.request(`invitations/${exhausted.token}/accept`, "POST", {}, intended);
    const guest = await f.page(undefined, 375);
    for (const [invitation, heading] of [[revoked, "这条邀请已撤销"], [expired, "这条邀请已过期"], [exhausted, "这条邀请的名额已用完"]] as const) {
      await guest.goto(`/app/join/${invitation.token}`);
      await expect(guest.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(guest.getByText("请联系邀请人索取新链接。", { exact: false })).toBeVisible();
      await expect(guest.getByRole("button", { name: "加入团队空间", exact: true })).toHaveCount(0);
      await verifyMobile(guest);
    }
    const joined = await f.page(intended);
    await joined.goto(`/app/join/${exhausted.token}`);
    await expect(joined.getByRole("link", { name: "进入团队空间", exact: true })).toBeVisible();
    await f.request(`invitations/${exhausted.token}/accept`, "POST", {}, other, 409);
    verifyIsolation(f);
  } finally { await f.close(); }
});
