import { test, expect, type Page } from "@playwright/test";
import jsQR from "jsqr";
import { mkdir, writeFile } from "node:fs/promises";
import type { Project, ProjectMember, PublicInvitation, PublicSpaceInvitationPreview } from "../../src/modules/projects/model.ts";
import type { CurrentPlanningView, PlanningInput, PlanVersion } from "../../src/modules/planning/types.ts";
import type { TaskProposal } from "../../src/modules/planning/service.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

interface ProjectDetail { project: Project; membership: ProjectMember; members: ProjectMember[] }
async function createSpace(f: IsolatedWorkspace, owner: FixtureIdentity) {
  return f.request<Project>("projects", "POST", { name: "一起完成新人可操作的演示作品", timezone: "Asia/Shanghai", goal: "帮助新人完成核心使用流程", minimumDeliverable: "可操作的一条完整网页流程", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString() }, owner, 201);
}
async function issue(f: IsolatedWorkspace, owner: FixtureIdentity, projectId: string, maxUses: number, invitedEmail?: string) {
  const detail = await f.request<ProjectDetail>(`projects/${projectId}`, "GET", undefined, owner);
  return f.request<{ token: string }>(`projects/${projectId}/invitations`, "POST", { expectedRevision: detail.project.revision, role: "member", maxUses, ...(invitedEmail ? { invitedEmail } : {}) }, owner, 201);
}
async function browserAuthenticate(f: IsolatedWorkspace, page: Page, email: string, register: boolean) {
  if (register) await page.getByLabel("姓名 / 昵称", { exact: true }).fill("扫码加入的队友");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByRole("button", { name: register ? "获取注册验证码" : "获取登录验证码", exact: true }).click();
  await expect(page.getByLabel("8 位验证码", { exact: true })).toBeVisible();
  await page.getByLabel("8 位验证码", { exact: true }).fill(await f.challengeCode(email));
  await page.getByRole("button", { name: register ? "验证邮箱并注册 / 登录" : "验证并登录", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname.startsWith("/app/join/"));
}
async function acceptOnPage(page: Page) {
  await page.getByLabel("我已核对目标与角色，明确接受这条邀请。", { exact: true }).check();
  await page.getByRole("button", { name: "加入团队空间", exact: true }).click();
  await expect(page.getByRole("link", { name: "进入团队空间", exact: true })).toBeVisible();
}
async function identityFromPage(page: Page, email: string): Promise<FixtureIdentity> {
  const profile = await page.evaluate(async () => (await (await fetch("/api/v1/me")).json()).data.profile);
  const cookies = await page.context().cookies();
  const cookie = cookies.find(value => value.httpOnly);
  if (!cookie) throw new Error("Browser fixture login did not establish a session");
  return { email, userId: profile.id, cookie: `${cookie.name}=${cookie.value}` };
}

test("a local QR and two-use link preserve guest registration/login context and consume only distinct new memberships", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("space-owner@example.test", "邀请人小林"), project = await createSpace(f, owner);
    const ownerPage = await f.page(owner, 375);
    await ownerPage.goto(`/app/projects/${project.id}/team`);
    await expect(ownerPage.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link")).toHaveText(["找比赛", "我的参赛", "工具与资料"]);
    await ownerPage.getByRole("button", { name: "邀请队友", exact: true }).click();
    await ownerPage.getByText("自定义人数", { exact: true }).click();
    await ownerPage.getByLabel("自定义人数（1–50）", { exact: true }).fill("2");
    await ownerPage.getByRole("button", { name: "生成邀请链接", exact: true }).click();
    const link = ownerPage.getByLabel("本次邀请链接", { exact: true });
    await expect(link).toHaveValue(/\/app\/join\//);
    const invitationUrl = await link.inputValue(), joinPath = new URL(invitationUrl).pathname;
    const token = joinPath.split("/").at(-1)!;
    await ownerPage.getByText("展示同一链接的二维码", { exact: true }).click();
    const qr = ownerPage.getByRole("img", { name: "扫码打开团队空间邀请", exact: true });
    await expect(qr).toBeVisible();
    const bitmap = await qr.evaluate(svg => {
      const size = Number(svg.getAttribute("viewBox")!.split(" ")[2]), scale = 4, width = size * scale;
      const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
      for (const cell of svg.querySelector("path")!.getAttribute("d")!.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
        for (let y = Number(cell[2]) * scale; y < (Number(cell[2]) + 1) * scale; y++) for (let x = Number(cell[1]) * scale; x < (Number(cell[1]) + 1) * scale; x++) {
          const index = (y * width + x) * 4; pixels[index] = pixels[index + 1] = pixels[index + 2] = 17;
        }
      }
      return { pixels: [...pixels], width };
    });
    const decoded = jsQR(new Uint8ClampedArray(bitmap.pixels), bitmap.width, bitmap.width);
    expect(Boolean(decoded && decoded.data === invitationUrl), "Rendered QR must decode to the same invite URL").toBeTruthy();
    expect(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();

    const previewResponse = await f.raw(`invitations/${token}/public-preview`);
    expect(previewResponse.ok).toBeTruthy();
    expect(previewResponse.headers.get("cache-control")).toContain("no-store");
    const preview = (await previewResponse.json()).data as PublicSpaceInvitationPreview;
    expect(preview.scopeName).toBe(project.name); expect(preview.maxUses).toBe(2); expect(preview.usedUses).toBe(0);
    for (const key of ["scopeId", "invitedEmail", "members", "goal", "tokenHash", "acceptedBy", "acceptances"]) expect(Object.hasOwn(preview, key)).toBe(false);
    const first = await f.page(undefined, 375);
    // This navigation simulates using the decoded link; no physical phone claim.
    await first.goto(new URL(decoded!.data).pathname);
    await expect(first.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
    await expect(first.getByRole("link", { name: "登录后继续核对邀请", exact: true })).toHaveAttribute("href", `/login?returnTo=${encodeURIComponent(joinPath)}`);
    await expect(first.getByRole("link", { name: "注册账号后回到此邀请", exact: true })).toHaveAttribute("href", `/register?returnTo=${encodeURIComponent(joinPath)}`);
    const headerRegistration = first.locator('[aria-label="账号操作"]').getByRole("link", { name: "注册", exact: true });
    await expect(headerRegistration).toHaveAttribute("href", `/register?returnTo=${encodeURIComponent(joinPath)}`);
    await headerRegistration.click();
    await browserAuthenticate(f, first, "space-first@example.test", true);
    const firstIdentity = await identityFromPage(first, "space-first@example.test");
    await f.request(`projects/${project.id}`, "GET", undefined, firstIdentity, 404);
    await acceptOnPage(first);
    const firstDetail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, firstIdentity);
    expect(firstDetail.membership.role).toBe("member");

    const second = await f.page();
    await second.goto(joinPath); await second.getByRole("link", { name: "登录后继续核对邀请", exact: true }).click();
    await browserAuthenticate(f, second, "space-second@example.test", false); await acceptOnPage(second);
    const secondIdentity = await identityFromPage(second, "space-second@example.test");
    await f.request(`invitations/${token}/accept`, "POST", {}, firstIdentity);
    const invitations = await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner);
    expect(invitations[0]?.usedUses).toBe(2); expect(invitations[0]?.remainingUses).toBe(0);
    expect((await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, secondIdentity)).members).toHaveLength(3);
    const thirdIdentity = await f.login("space-third@example.test", "没有名额的队友");
    const third = await f.page(thirdIdentity);
    await third.goto(joinPath);
    await expect(third.getByRole("heading", { name: "这条邀请的名额已用完", exact: true })).toBeVisible();
    await expect(third.getByRole("button", { name: "加入团队空间", exact: true })).toHaveCount(0);
    await f.request(`invitations/${token}/accept`, "POST", {}, thirdIdentity, 409);
    await first.reload(); await expect(first.getByRole("link", { name: "进入团队空间", exact: true })).toBeVisible();
    expect(f.externalRequests).toEqual([]);
    expect(f.apiReads.some(value => /POST .*generation|POST .*navigator\/messages|POST .*roadshow|POST .*ppt/.test(value))).toBe(false);
  } finally { await f.close(); }
});

test("email-restricted, revoked and expired invitations give a next step without exposing private recipient details", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("restricted-owner@example.test", "管理员"), intended = await f.login("restricted-member@example.test", "指定队友"), other = await f.login("different-member@example.test", "另一个账号");
    const project = await createSpace(f, owner), invitation = await issue(f, owner, project.id, 3, intended.email);
    const page = await f.page(other, 375); await page.goto(`/app/join/${invitation.token}`);
    await expect(page.getByText("需要使用邀请人限定的已验证邮箱。", { exact: false })).toBeVisible();
    await expect(page.getByText(intended.email, { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "加入团队空间", exact: true })).toHaveCount(0);
    await f.request(`invitations/${invitation.token}/accept`, "POST", {}, other, 403);
    await f.request(`invitations/${invitation.token}/accept`, "POST", {}, intended);
    const invites = await f.request<PublicInvitation[]>(`projects/${project.id}/invitations`, "GET", undefined, owner);
    const detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
    await f.request(`projects/${project.id}/invitations/${invites[0]!.id}`, "DELETE", { expectedRevision: detail.project.revision }, owner);
    const guest = await f.page(); await guest.goto(`/app/join/${invitation.token}`);
    await expect(guest.getByRole("heading", { name: "这条邀请已撤销", exact: true })).toBeVisible();
    await expect(guest.getByText("请联系邀请人索取新链接。", { exact: false })).toBeVisible();
    const joined = await f.page(intended); await joined.goto(`/app/join/${invitation.token}`);
    await expect(joined.getByRole("link", { name: "进入团队空间", exact: true })).toBeVisible();
    const expiring = await issue(f, owner, project.id, 1);
    // Only fixture rows are changed to move time; the running database is untouched.
    await f.database.query("UPDATE projects_invitation SET expires_at=$1,created_at=$2 WHERE scope_id=$3 AND status='pending'", [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 72 * 60 * 60_000).toISOString(), project.id]);
    await guest.goto(`/app/join/${expiring.token}`);
    await expect(guest.getByRole("heading", { name: "这条邀请已过期", exact: true })).toBeVisible();
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

async function preparePlan(f: IsolatedWorkspace, owner: FixtureIdentity, project: Project, peers: FixtureIdentity[]) {
  const invitation = await issue(f, owner, project.id, peers.length);
  for (const peer of peers) await f.request(`invitations/${invitation.token}/accept`, "POST", {}, peer);
  const detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
  const startsAt = new Date(Date.now() + 60 * 60_000).toISOString(), endsAt = new Date(Date.now() + 9 * 60 * 60_000).toISOString();
  for (const member of [owner, ...peers]) await f.request(`projects/${project.id}/my-availability`, "PUT", { expectedRevision: 0, timezone: "UTC", windows: [{ id: `window-${member.userId}`, startsAt, endsAt, effectiveMinutes: 480 }] }, member);
  const facts = await f.request<PlanningInput>(`projects/${project.id}/planning-input`, "GET", undefined, owner);
  const primary = detail.members.find(member => member.userId === peers[0]!.userId)!.membershipId, dependentOwner = detail.members.find(member => member.userId === peers[1]!.userId)!.membershipId;
  const tasks: TaskProposal[] = ["implementation", "material", "learning", ...facts.requiredTaskKinds].map((kind, index) => ({
    id: `ux-task-${index}`, projectId: project.id, title: index === 0 ? "做出可以演示的 Demo" : index === 1 ? "录制演示视频" : index === 2 ? "先准备视频介绍词" : `交付检查 ${index}`,
    priority: "must", kind: kind as TaskProposal["kind"], ownerMembershipId: index === 0 ? primary : index < 3 ? dependentOwner : detail.membership.membershipId,
    helperEfforts: [], deliverable: "实际可检查的成果", acceptanceCriteria: ["核心流程可以复现"], reviewerMembershipId: detail.membership.membershipId,
    durationEstimate: { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "人工试做后估算" }, dependencyTaskIds: index === 1 ? ["ux-task-0"] : [],
    deadlineRef: facts.deadlines[0]!.id, requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0,
  }));
  const draft = await f.request<PlanVersion>(`projects/${project.id}/plan-versions`, "POST", { tasks, buffers: [{ deadlineId: facts.deadlines[0]!.id, reservedMinutes: 20, basis: "留出正式提交时间" }], reason: "确认并行准备与实际依赖", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "ux-plan-draft" }, owner, 201);
  expect(draft.status).toBe("ready");
  await f.request(`projects/${project.id}/plan-versions/${draft.id}/apply`, "POST", { expectedRevision: draft.revision, acknowledgedIssueCodes: [...new Set(draft.validation!.issues.map(issue => issue.code))], idempotencyKey: "ux-plan-apply" }, owner);
}

test("teammates see completion awaiting review and useful parallel work; only accepted work releases dependencies", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("task-owner@example.test", "管理员"), maker = await f.login("task-maker@example.test", "开发队友"), presenter = await f.login("task-presenter@example.test", "演示队友"), outsider = await f.login("task-outsider@example.test", "外部账号");
    const project = await createSpace(f, owner); await preparePlan(f, owner, project, [maker, presenter]);
    const makerPage = await f.page(maker), presenterPage = await f.page(presenter, 375), managerPage = await f.page(owner);
    await presenterPage.goto(`/app/projects/${project.id}/plan`);
    const adjustments = presenterPage.locator("details").filter({ has: presenterPage.getByText("查看计划依据与历史草案", { exact: true }) }).first();
    await expect(adjustments).not.toHaveAttribute("open", "");
    const board = presenterPage.getByRole("region", { name: "团队任务板", exact: true });
    await expect(board).toBeVisible();
    await expect(presenterPage.getByRole("navigation", { name: "团队空间", exact: true }).getByRole("link", { name: "任务进度", exact: true })).toHaveAttribute("aria-current", "page");
    expect(await board.evaluate((element) => Boolean(element.compareDocumentPosition([...document.querySelectorAll("summary")].find(item => item.textContent === "查看计划依据与历史草案")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBeTruthy();
    const waiting = presenterPage.locator("#task-ux-task-1");
    await expect(waiting).toContainText("还在等：做出可以演示的 Demo");
    await expect(waiting).toContainText("等待时你可以先做：先准备视频介绍词");
    await expect(waiting.getByRole("button", { name: "开始做", exact: true })).toBeDisabled();
    await makerPage.goto(`/app/projects/${project.id}/plan`);
    const demo = makerPage.locator("#task-ux-task-0");
    await demo.getByRole("button", { name: "开始做", exact: true }).click();
    await demo.getByLabel("这次完成了什么 / 进度说明", { exact: true }).fill("先做出可以操作的核心流程。");
    await demo.getByRole("button", { name: "保存进度", exact: true }).click();
    await demo.getByRole("button", { name: "提交成果，请队友检查", exact: true }).click();
    await demo.getByLabel("这次完成了什么 / 进度说明", { exact: true }).fill("已做出网页演示流程，请队友检查。");
    await demo.getByRole("button", { name: "提交到待检查", exact: true }).click();
    await expect(demo).toContainText("成果已交到待检查，队友可以看到。");
    await presenterPage.getByRole("button", { name: "读取最新进度", exact: true }).click();
    await expect(waiting.getByRole("button", { name: "开始做", exact: true })).toBeDisabled();
    await presenterPage.getByRole("button", { name: "全队任务", exact: true }).click();
    await expect(presenterPage.locator("#task-ux-task-0")).toContainText("待检查");
    await expect(presenterPage.locator("#task-ux-task-0").getByRole("button", { name: "检查通过", exact: true })).toHaveCount(0);
    await managerPage.goto(`/app/projects/${project.id}/plan`);
    const review = managerPage.locator("#task-ux-task-0");
    await review.getByRole("button", { name: "检查通过", exact: true }).click();
    await review.getByLabel("怎样确认满足检查条件", { exact: true }).fill("按说明实际完成核心流程并确认结果。");
    await review.getByLabel("成果链接或记录依据（每行一项）", { exact: true }).fill("https://example.test/fixture-demo-evidence");
    await review.getByRole("button", { name: "确认检查通过", exact: true }).click();
    await expect(review).toContainText("检查已通过，依赖此成果的任务可以继续。");
    await presenterPage.getByRole("button", { name: "读取最新进度", exact: true }).click();
    await expect(waiting.getByRole("button", { name: "开始做", exact: true })).toBeEnabled();
    for (const endpoint of ["plans/current", "progress"]) {
      const forbidden = await f.raw(`projects/${project.id}/${endpoint}`, "GET", undefined, outsider);
      expect([403, 404]).toContain(forbidden.status);
    }
    const current = await f.request<CurrentPlanningView>(`projects/${project.id}/plans/current`, "GET", undefined, presenter);
    expect(current.tasks.find(task => task.id === "ux-task-0")?.status).toBe("done");
    expect(await presenterPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    await mkdir(".runtime/previews", { recursive: true });
    await presenterPage.evaluate(() => window.scrollTo(0, 0));
    await expect(presenterPage.getByRole("heading", { name: "当前任务计划", exact: true })).toBeInViewport();
    const mobileLayout = await presenterPage.evaluate(() => ({
      width: innerWidth, height: innerHeight, scrollY,
      headings: [...document.querySelectorAll("h2")].filter(item => ["当前任务计划", "分工与任务进度"].includes(item.textContent ?? "")).map(item => ({ text: item.textContent, y: Math.round(item.getBoundingClientRect().top) })),
    }));
    await presenterPage.screenshot({ path: ".runtime/previews/ux-team-task-board-375.png", fullPage: true });
    await presenterPage.screenshot({ path: ".runtime/previews/ux-team-task-board-375-first-screen.png", fullPage: false });
    await presenterPage.setViewportSize({ width: 1280, height: 900 });
    await presenterPage.evaluate(() => window.scrollTo(0, 0));
    const desktopLayout = await presenterPage.evaluate(() => ({
      width: innerWidth, height: innerHeight, scrollY,
      headings: [...document.querySelectorAll("h2")].filter(item => ["当前任务计划", "分工与任务进度"].includes(item.textContent ?? "")).map(item => ({ text: item.textContent, y: Math.round(item.getBoundingClientRect().top) })),
    }));
    await presenterPage.screenshot({ path: ".runtime/previews/ux-team-task-board-1280.png", fullPage: true });
    await presenterPage.screenshot({ path: ".runtime/previews/ux-team-task-board-1280-first-screen.png", fullPage: false });
    await writeFile(".runtime/previews/ux-team-task-board-layout.json", JSON.stringify({ mobile: mobileLayout, desktop: desktopLayout }, null, 2));
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("shared project material is explicitly selected, private artifacts remain private, and source reading starts no model request", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("material-owner@example.test", "资料管理员"), outsider = await f.login("material-outsider@example.test", "其他账号"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375); await page.goto(`/roadshow?projectId=${encodeURIComponent(project.id)}`);
    await expect(page.getByRole("link", { name: "返回团队空间，查看代码与提交 →", exact: true })).toHaveAttribute("href", `/app/projects/${project.id}/delivery`);
    await expect(page.getByText("空间资料复用接口尚未接入。", { exact: false })).toHaveCount(0);
    await page.getByLabel("选择团队空间", { exact: true }).selectOption(project.id);
    await page.getByRole("button", { name: "查看将带入的资料", exact: true }).click();
    await expect(page.getByText(project.goal, { exact: false }).first()).toBeVisible();
    await expect(page.getByText("计划会单独带入", { exact: false })).toBeVisible();
    const source = await f.raw(`me/presentation-projects/${project.id}`, "GET", undefined, owner);
    expect(source.ok).toBeTruthy(); expect(source.headers.get("cache-control")).toContain("no-store");
    const snapshot = (await source.json()).data;
    expect(snapshot.projectId).toBe(project.id); expect(snapshot.completed).toEqual([]);
    for (const field of ["members", "profile", "answers", "code", "email"]) expect(Object.hasOwn(snapshot, field)).toBe(false);
    const denied = await f.raw(`me/presentation-projects/${project.id}`, "GET", undefined, outsider);
    expect([403, 404]).toContain(denied.status);
    expect(f.apiReads.filter(value => value.startsWith("POST ") && /roadshow|ppt|generation|navigator\/messages/.test(value))).toEqual([]);
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});

test("a member can select multiple duties without assessment and only explicitly shared fields reach the team", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("duties-owner@example.test", "管理员"), member = await f.login("duties-member@example.test", "新队友"), project = await createSpace(f, owner);
    const invitation = await issue(f, owner, project.id, 1);
    await f.request(`invitations/${invitation.token}/accept`, "POST", {}, member);
    const page = await f.page(member, 375); await page.goto(`/app/projects/${project.id}/assessment`);
    const steps = page.getByRole("navigation", { name: "队友与分工内容", exact: true });
    await expect(steps.getByRole("link")).toHaveText(["队友与时间", "职责与分工"]);
    await expect(page.getByRole("navigation", { name: "团队空间", exact: true }).getByRole("link", { name: "任务进度", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: /^设计界面 ·/ }).check();
    await page.getByRole("checkbox", { name: /^做出核心功能 ·/ }).check();
    const privateExperience = "PRIVATE_MEMBER_EXPERIENCE_ONLY";
    await page.getByLabel("做过什么，或希望从哪里开始（选填）", { exact: true }).fill(privateExperience);
    await page.getByRole("checkbox", { name: "愿意负责的工作", exact: true }).check();
    await page.getByRole("button", { name: "保存本人意愿与共享范围", exact: true }).click();
    await expect(page.getByText("本次意愿与共享范围已保存。团队确认分工后才成为正式任务安排。", { exact: true })).toBeVisible();
    const shared = await f.request<{ intentions: { duties?: string[]; experience?: string }[] }>(`projects/${project.id}/shared-intentions`, "GET", undefined, owner);
    expect(shared.intentions[0]?.duties).toEqual(["design", "development"]);
    expect(Object.hasOwn(shared.intentions[0]!, "experience")).toBe(false);
    const ownerPage = await f.page(owner); await ownerPage.goto(`/app/projects/${project.id}/assessment`);
    await expect(ownerPage.getByText("愿意做：设计界面、做出核心功能", { exact: true })).toBeVisible();
    await expect(ownerPage.getByText(privateExperience, { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    expect(f.apiReads.filter(value => value.startsWith("POST ") && /assessment-attempts|role-help|generation|navigator\/messages/.test(value))).toEqual([]);
    expect(f.externalRequests).toEqual([]);
  } finally { await f.close(); }
});
