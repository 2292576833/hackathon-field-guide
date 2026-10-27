import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import type { PublicRecruitingCard, RecruitingApplication, RecruitingPage, RecruitingPost, RecruitingProfileView } from "../../src/modules/recruiting/model.ts";
import type { AssistantConversation, TeamAssistantContextSnapshot } from "../../src/modules/team-assistant/model.ts";
import type { SuggestionReceipt, TeamFeedSnapshot } from "../../src/modules/team-collaboration/types.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

test.use({ trace: "off", video: "off", screenshot: "off" });
const privateResume = "隔离私人经历：PRIVATE_RESUME_COMPLETION，不应自动公开";
const privateReply = "隔离已保存回答：PRIVATE_FULL_COMPLETION。先准备一条真实体验流程，再讨论演示安排。";
const sharedFragment = "隔离明确共享：SHARED_FRAGMENT_COMPLETION，先准备真实体验流程。";
const bench = (page: Page) => page.getByRole("region", { name: "团队协作工作台", exact: true });
const assistantDialog = (page: Page) => page.getByRole("dialog", { name: "我的空间 AI 助手", exact: true });

async function createSpace(f: IsolatedWorkspace, manager: FixtureIdentity, name = "隔离练习：完整协作闭环") {
  return f.request<Project>("projects", "POST", { name, timezone: "Asia/Shanghai", goal: "让第一次参赛的伙伴交出可体验作品", minimumDeliverable: "一条真实完整的体验流程" }, manager, 201);
}
async function joinMember(f: IsolatedWorkspace, projectId: string, manager: FixtureIdentity, member: FixtureIdentity) {
  const detail = await f.request<{ project: Project }>(`projects/${projectId}`, "GET", undefined, manager);
  const invite = await f.request<{ token: string }>(`projects/${projectId}/invitations`, "POST", { expectedRevision: detail.project.revision, role: "member", maxUses: 1 }, manager, 201);
  await f.request(`invitations/${invite.token}/accept`, "POST", {}, member);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function openFeed(page: Page): Promise<Locator> {
  await bench(page).getByRole("tab", { name: "团队动态", exact: true }).click();
  const feed = bench(page).getByRole("region", { name: "团队动态", exact: true });
  await expect(feed).toBeVisible();
  await feed.getByRole("button", { name: "刷新动态", exact: true }).click();
  return feed;
}
async function openAssistant(page: Page) {
  await bench(page).getByRole("button", { name: "打开我的空间 AI 助手", exact: true }).click();
  const dialog = assistantDialog(page); await expect(dialog).toBeVisible(); return dialog;
}
async function closeAssistant(page: Page) {
  await assistantDialog(page).getByRole("button", { name: "关闭助手", exact: true }).click();
  await expect(assistantDialog(page)).not.toBeVisible();
}
async function expectNoExternalGeneration(f: IsolatedWorkspace) {
  expect(f.externalRequests).toEqual([]);
  expect((await f.database.query("SELECT id FROM ai_usage_attempts")).rows).toEqual([]);
  expect(f.apiReads.filter(item => /^(POST|PATCH|DELETE) (navigator\/messages|me\/recruiting-profile\/summary|projects\/[^/]+\/assistant\/(messages|feasibility))$/.test(item))).toEqual([]);
}

/** A successful persisted response is explicit fixture data, not a generated DSH
 * response. All reads, authorship/source checks, sharing, revocation and context
 * projection still run through the real root handlers and SQL repositories. */
async function savedPrivateAnswer(f: IsolatedWorkspace, owner: FixtureIdentity, projectId: string) {
  await f.request<AssistantConversation>(`projects/${projectId}/assistant/conversation`, "GET", undefined, owner);
  const requestId = randomUUID(), responseId = randomUUID(), now = f.app.clock.now().toISOString();
  await f.database.transaction(async sql => {
    await sql.query("INSERT INTO team_assistant_requests(user_id,project_id,request_id,request_hash,message,status,response_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,'succeeded',$6,$7,$8)",
      [owner.userId, projectId, requestId, `explicit-saved-response-fixture-${requestId}`, "隔离已保存问题：我现在先做什么？", responseId, now, new Date(f.app.clock.now().getTime() + 3_600_000).toISOString()]);
    await sql.query("INSERT INTO team_assistant_messages(user_id,project_id,request_id,id,role,content,created_at,provider,links,coverage) VALUES($1,$2,$3,$4,'assistant',$5,$6,'dsh','[]'::jsonb,NULL)", [owner.userId, projectId, requestId, responseId, privateReply, now]);
    await sql.query("UPDATE team_assistant_conversations SET revision=revision+1,updated_at=$3 WHERE user_id=$1 AND project_id=$2", [owner.userId, projectId, now]);
  });
  return { requestId, responseId };
}

test("375px manual recruiting card remains private through preview, publishes only confirmed fields and withdraws without deleting the private profile", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("completion-card@example.test", "准备名片的新人"), page = await f.page(owner, 375), visitor = await f.page(undefined, 375);
    await page.goto("/recruiting");
    await page.getByText("我的参赛名片：填写职责与参赛目标", { exact: true }).click();
    const editor = page.getByRole("region", { name: "先说清愿意做什么，再找到伙伴", exact: true });
    await editor.getByRole("group", { name: "主要想承担的职责（可多选）", exact: true }).getByRole("checkbox", { name: "前端开发", exact: true }).check();
    await editor.getByRole("group", { name: "这次参赛想获得什么（可多选）", exact: true }).first().getByRole("checkbox", { name: "学习实践", exact: true }).check();
    await editor.getByLabel("简单介绍自己的经历", { exact: true }).fill(privateResume);
    await editor.getByText("其他选填信息：MBTI、年龄", { exact: true }).click();
    await editor.getByLabel("MBTI（选填）", { exact: true }).fill("INTP");
    await editor.getByLabel("年龄（选填）", { exact: true }).fill("23");
    await editor.getByRole("button", { name: "保存私人资料", exact: true }).click();
    await expect(editor.getByRole("button", { name: "自己填写名片", exact: true })).toBeEnabled();
    expect((await f.request<RecruitingPage<PublicRecruitingCard>>("recruiting/cards")).items).toEqual([]);
    await editor.getByRole("button", { name: "自己填写名片", exact: true }).click();
    await editor.getByLabel("名片标题（最多 100 字）", { exact: true }).fill("隔离名片：愿意先做前端原型");
    await editor.getByLabel(/^公开介绍（最多 1600 字/).fill("本人明确公开：愿意和伙伴做出可体验的小作品");
    const publish = editor.getByRole("button", { name: "确认发布名片", exact: true });
    await expect(publish).toBeDisabled();
    expect((await f.request<RecruitingPage<PublicRecruitingCard>>("recruiting/cards")).items).toEqual([]);
    await editor.getByRole("checkbox", { name: "我已核对预览，确认把这些内容发布到公开组队大厅。", exact: true }).check();
    await publish.click(); await expect(editor.getByRole("button", { name: "撤回公开名片", exact: true })).toBeVisible();
    const cards = await f.request<RecruitingPage<PublicRecruitingCard>>("recruiting/cards");
    expect(cards.items).toHaveLength(1); expect(cards.items[0]).toMatchObject({ age: null, mbti: null, avatarUrl: null });
    expect(JSON.stringify(cards)).not.toContain(privateResume); expect(JSON.stringify(cards)).not.toContain(owner.email);
    await visitor.goto("/recruiting"); await visitor.getByRole("button", { name: "看看伙伴名片", exact: true }).click();
    await expect(visitor.getByRole("heading", { name: "隔离名片：愿意先做前端原型", exact: true })).toBeVisible();
    await expect(visitor.locator("body")).not.toContainText(privateResume); await noOverflow(page); await noOverflow(visitor);
    await editor.getByRole("button", { name: "撤回公开名片", exact: true }).click();
    await expect(editor.getByText("已撤回", { exact: true })).toBeVisible();
    expect((await f.request<RecruitingPage<PublicRecruitingCard>>("recruiting/cards")).items).toEqual([]);
    await visitor.reload(); await visitor.getByRole("button", { name: "看看伙伴名片", exact: true }).click();
    await expect(visitor.getByRole("heading", { name: "隔离名片：愿意先做前端原型", exact: true })).toHaveCount(0);
    expect((await f.request<RecruitingProfileView>("me/recruiting-profile", "GET", undefined, owner)).profile.resume).toBe(privateResume);
    expect(f.apiReads.filter(item => item === "POST me/recruiting-card/publish")).toHaveLength(1);
    await expectNoExternalGeneration(f);
  } finally { await f.close(); }
});

test("public recruiting application, manager approval and applicant confirmation create one real ordinary membership, never at approval", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const manager = await f.login("completion-recruit-admin@example.test", "负责公开招募的队长"), applicant = await f.login("completion-recruit-new@example.test", "第一次申请加入的新人"), project = await createSpace(f, manager);
    const managerPage = await f.page(manager, 1280), applicantPage = await f.page(applicant, 375);
    await managerPage.goto(`/app/projects/${project.id}/team`);
    await managerPage.getByText("公开招募队友与处理加入申请", { exact: true }).click();
    const managerPanel = managerPage.getByRole("region", { name: "说清目标与需要的贡献", exact: true });
    await managerPanel.getByLabel("公开的空间名称", { exact: true }).fill("隔离公开招募空间");
    await managerPanel.getByLabel("招募标题", { exact: true }).fill("隔离招募：一起完成前端体验");
    await managerPanel.getByLabel("公开介绍", { exact: true }).fill("一起练习一条可体验的流程，职责和可用时间入队后共同核对。");
    await managerPanel.getByRole("group", { name: "希望补充的职责（可多选）", exact: true }).getByRole("checkbox", { name: "前端开发", exact: true }).check();
    await managerPanel.getByRole("group", { name: "这次参赛想获得什么（可多选）", exact: true }).getByRole("checkbox", { name: "学习实践", exact: true }).check();
    const publicButton = managerPanel.getByRole("button", { name: "确认公开招募", exact: true }); await expect(publicButton).toBeDisabled();
    await managerPanel.getByRole("checkbox", { name: "我已核对这些公开内容，并确认保存所选招募状态。", exact: true }).check();
    await publicButton.click(); await expect(managerPanel.getByRole("button", { name: "立即关闭招募", exact: true })).toBeVisible();
    const post = (await f.request<RecruitingPost>(`projects/${project.id}/recruiting-post`, "GET", undefined, manager));
    await applicantPage.goto("/recruiting");
    const publicPost = applicantPage.locator("article").filter({ has: applicantPage.getByRole("heading", { name: post.title, exact: true }) }).first();
    await publicPost.getByText("申请加入这个团队", { exact: true }).click();
    await publicPost.getByLabel("想承担什么、能贡献什么", { exact: true }).fill("隔离申请：我愿意准备前端体验，先与队友核对时间。");
    await publicPost.getByRole("button", { name: "提交站内申请", exact: true }).click();
    await expect(applicantPage.getByText("申请已保存到站内，等待管理员审核。审核通过后仍需你明确加入。", { exact: true })).toBeVisible();
    expect(await f.app.projectRepository.getMembership(project.id, applicant.userId)).toBeNull();
    await managerPanel.getByRole("button", { name: "读取最新记录，保留填写", exact: true }).click();
    const applicationCard = managerPanel.locator("article").filter({ has: managerPage.getByRole("heading", { name: "第一次申请加入的新人", exact: true }) });
    await applicationCard.getByLabel("给申请人的审核说明（选填）", { exact: true }).fill("隔离审核：同意申请，请本人确认这个空间。");
    await applicationCard.getByRole("button", { name: "批准申请，等待本人加入", exact: true }).click();
    await expect(managerPanel.getByText("申请已批准。对方明确点击加入并通过当前权限检查后，才会成为普通成员。", { exact: true })).toBeVisible();
    expect(await f.app.projectRepository.getMembership(project.id, applicant.userId)).toBeNull();
    await applicantPage.getByRole("button", { name: "读取最新申请", exact: true }).click();
    const confirmJoin = applicantPage.getByRole("button", { name: "确认加入空间", exact: true }); await expect(confirmJoin).toBeDisabled();
    await applicantPage.getByRole("checkbox", { name: "我确认加入「隔离公开招募空间」，成为普通成员。", exact: true }).check();
    await confirmJoin.click(); await expect(applicantPage).toHaveURL(`${f.origin}/app/projects/${project.id}`);
    await expect(bench(applicantPage)).toBeVisible();
    const membership = await f.app.projectRepository.getMembership(project.id, applicant.userId);
    expect(membership).toMatchObject({ role: "member", status: "active" });
    const accepted = (await f.request<RecruitingApplication[]>(`projects/${project.id}/recruiting-applications`, "GET", undefined, manager)).find(item => item.applicantUserId === applicant.userId)!;
    expect(accepted.status).toBe("joined"); expect(accepted.membershipId).toBe(membership!.membershipId);
    const invitationsBeforeRetry = await f.app.projects.listProjectInvitations({ userId: manager.userId, platformRoles: ["user"] }, project.id);
    await f.request(`recruiting/applications/${accepted.id}/join`, "POST", { expectedRevision: accepted.revision, confirmed: true }, applicant);
    expect(await f.app.projects.listProjectInvitations({ userId: manager.userId, platformRoles: ["user"] }, project.id)).toEqual(invitationsBeforeRetry);
    expect((await f.database.query("SELECT membership_id FROM projects_project_membership WHERE project_id=$1 AND user_id=$2", [project.id, applicant.userId])).rows).toHaveLength(1);
    await noOverflow(applicantPage); await expectNoExternalGeneration(f);
  } finally { await f.close(); }
});

test("saved private space answer requires preview and explicit sharing, reaches teammates and their real context, then withdraws from both", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const author = await f.login("completion-share-owner@example.test", "主动分享建议的队长"), peer = await f.login("completion-share-peer@example.test", "读取团队建议的成员"), project = await createSpace(f, author);
    await joinMember(f, project.id, author, peer); await savedPrivateAnswer(f, author, project.id);
    const authorPage = await f.page(author, 375), peerPage = await f.page(peer, 1280);
    await authorPage.goto(`/app/projects/${project.id}`); await peerPage.goto(`/app/projects/${project.id}`);
    const before = await f.request<TeamAssistantContextSnapshot>(`projects/${project.id}/assistant/context`, "GET", undefined, peer);
    expect(JSON.stringify(before)).not.toContain(privateReply);
    expect((await f.request<AssistantConversation>(`projects/${project.id}/assistant/conversation?userId=${author.userId}`, "GET", undefined, peer)).messages).toEqual([]);
    const dialog = await openAssistant(authorPage); await expect(dialog).toContainText(privateReply);
    await dialog.getByRole("button", { name: "选择片段分享给队友", exact: true }).click();
    await dialog.getByLabel("选择并编辑要交给队友的摘录", { exact: true }).fill(sharedFragment);
    const share = dialog.getByRole("button", { name: "确认分享给团队", exact: true }); await expect(share).toBeDisabled();
    await dialog.getByRole("button", { name: "预览摘录", exact: true }).click();
    expect((await f.request<TeamFeedSnapshot>(`projects/${project.id}/team-feed`, "GET", undefined, peer)).items).toEqual([]);
    await share.click(); await expect(dialog.getByText("所选建议已发布到本空间的团队动态，队友可以查看和讨论。", { exact: true })).toBeVisible();
    await closeAssistant(authorPage); const peerFeed = await openFeed(peerPage); await expect(peerFeed).toContainText(sharedFragment); await expect(peerFeed).not.toContainText(privateReply);
    const after = await f.request<TeamAssistantContextSnapshot>(`projects/${project.id}/assistant/context`, "GET", undefined, peer);
    expect(JSON.stringify(after.facts)).toContain(sharedFragment); expect(JSON.stringify(after)).not.toContain(privateReply); expect(after.fingerprint).not.toBe(before.fingerprint);
    const peerAssistant = await openAssistant(peerPage); await peerAssistant.getByText("查看当前资料与记忆说明", { exact: true }).click(); await expect(peerAssistant).toContainText(sharedFragment); await closeAssistant(peerPage);
    const authorFeed = await openFeed(authorPage), entry = authorFeed.locator("li").filter({ has: authorPage.getByRole("heading", { name: "空间助手：请队友一起考虑", exact: true }) });
    await entry.getByRole("button", { name: "采纳为团队决定", exact: true }).click(); await entry.getByRole("button", { name: "确认采纳当前版本", exact: true }).click();
    await expect(entry.getByText("已采纳决定", { exact: true })).toBeVisible();
    const current = await f.request<{ plan: unknown }>(`projects/${project.id}/plans/current`, "GET", undefined, peer); expect(current.plan).toBeNull();
    await entry.getByRole("button", { name: "撤回", exact: true }).click(); await entry.getByRole("button", { name: "确认撤回本人建议", exact: true }).click();
    await expect(authorFeed).toContainText("已撤回"); await peerFeed.getByRole("button", { name: "刷新动态", exact: true }).click();
    await expect(peerFeed).not.toContainText(sharedFragment); await expect(peerFeed).toContainText("正文不再显示，也不再作为团队 AI 上下文。");
    const withdrawn = await f.request<TeamAssistantContextSnapshot>(`projects/${project.id}/assistant/context`, "GET", undefined, peer);
    expect(JSON.stringify(withdrawn.facts)).not.toContain(sharedFragment); expect(withdrawn.fingerprint).not.toBe(after.fingerprint);
    expect((await f.request<AssistantConversation>(`projects/${project.id}/assistant/conversation`, "GET", undefined, author)).messages[0].content).toBe(privateReply);
    expect(f.apiReads.filter(item => item === `POST projects/${project.id}/team-feed`)).toHaveLength(1);
    await noOverflow(authorPage); await expectNoExternalGeneration(f);
  } finally { await f.close(); }
});

test("private answer authorship and source-space checks cannot be bypassed, and clearing the saved source hides shared text while retaining request history", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const author = await f.login("completion-source-owner@example.test", "管理私人来源的队长"), peer = await f.login("completion-source-peer@example.test", "读取有效摘录的队友"), project = await createSpace(f, author), other = await createSpace(f, author, "隔离另一个空间");
    await joinMember(f, project.id, author, peer); const source = await savedPrivateAnswer(f, author, project.id);
    const input = { sourceKind: "space_assistant", sourceId: source.responseId, title: "隔离来源存续测试", body: sharedFragment, idempotencyKey: randomUUID() };
    for (const [identity, projectId] of [[peer, project.id], [author, other.id]] as const) {
      const response = await f.raw(`projects/${projectId}/team-feed`, "POST", { ...input, idempotencyKey: randomUUID() }, identity);
      expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("SHARE_SOURCE_UNAVAILABLE");
    }
    const saved = await f.request<SuggestionReceipt>(`projects/${project.id}/team-feed`, "POST", input, author, 201);
    const authorPage = await f.page(author, 375), peerPage = await f.page(peer, 375);
    await authorPage.goto(`/app/projects/${project.id}`); await peerPage.goto(`/app/projects/${project.id}`);
    const peerFeed = await openFeed(peerPage); await expect(peerFeed).toContainText(sharedFragment);
    const dialog = await openAssistant(authorPage); await expect(dialog).toContainText(privateReply);
    await dialog.getByRole("button", { name: "清空本空间对话", exact: true }).click();
    await dialog.getByRole("button", { name: "确认清空此空间对话", exact: true }).click();
    await expect(dialog).toContainText("本空间私人对话已清空。"); await expect(dialog).not.toContainText(privateReply);
    await peerFeed.getByRole("button", { name: "刷新动态", exact: true }).click(); await expect(peerFeed).not.toContainText(sharedFragment); await expect(peerFeed).toContainText("来源已变化或当前不可用");
    const feed = await f.request<TeamFeedSnapshot>(`projects/${project.id}/team-feed`, "GET", undefined, peer);
    expect(feed.items.find(item => item.id === saved.id)).toMatchObject({ kind: "unavailable", status: "source_unavailable" });
    expect(JSON.stringify(feed)).not.toContain(sharedFragment);
    expect(JSON.stringify((await f.request<TeamAssistantContextSnapshot>(`projects/${project.id}/assistant/context`, "GET", undefined, peer)).facts)).not.toContain(sharedFragment);
    expect((await f.database.query("SELECT request_id FROM team_assistant_requests WHERE user_id=$1 AND project_id=$2", [author.userId, project.id])).rows).toEqual([{ request_id: source.requestId }]);
    expect((await f.database.query("SELECT id FROM team_assistant_messages WHERE user_id=$1 AND project_id=$2", [author.userId, project.id])).rows).toEqual([]);
    await noOverflow(peerPage); await expectNoExternalGeneration(f);
  } finally { await f.close(); }
});
