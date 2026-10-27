import { test, expect, type Page } from "@playwright/test";
import type { Project, ProjectMember } from "../../src/modules/projects/model.ts";
import type { DeliveryVerification, GitOperation, SubmissionRecord } from "../../src/modules/github/types.ts";
import type { SpaceDeliverySummary } from "../../src/modules/space-workflow/index.ts";
import type { EventRuleVersion, ProjectRuleConfirmation } from "../../src/modules/events/index.ts";
import { isolatedWorkspace, type FixtureIdentity, type IsolatedWorkspace } from "./isolated-workspace.ts";

type DeliverySummary = SpaceDeliverySummary;
interface ProjectDetail { project: Project; membership: ProjectMember; members: ProjectMember[] }
interface BrowserRead { method: string; path: string }

const stageLabels = ["组队与选方向", "赛前准备", "比赛进行中", "演示与提交", "赛后复盘"] as const;
const oldCommit = "a".repeat(40), currentCommit = "b".repeat(40);

async function createSpace(f: IsolatedWorkspace, owner: FixtureIdentity, completeGoal = true) {
  return f.request<Project>("projects", "POST", {
    name: "阶段工作台隔离验收空间", timezone: "Asia/Shanghai",
    goal: completeGoal ? "帮助新人完成一条实际可操作的参赛流程" : "",
    minimumDeliverable: completeGoal ? "可以演示的完整网页流程" : "",
    deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
  }, owner, 201);
}

/** Include page-route mocks in the request audit; f.apiReads only sees requests
 * handled by the context fixture. URLs, session cookies and invitation tokens
 * are never copied into diagnostic output. */
function observeReads(page: Page): BrowserRead[] {
  const reads: BrowserRead[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/")) reads.push({ method: request.method(), path: path.slice("/api/v1/".length).replace(/invitations\/[^/]+/, "invitations/[token]") });
  });
  return reads;
}

function assertReadOnly(f: IsolatedWorkspace, reads: BrowserRead[]) {
  expect(reads.filter(read => read.method !== "GET"), "Browsing stages and checklists must not create paid jobs or repository writes").toEqual([]);
  expect(reads.filter(read => /^me\/(participant-profile|participation|roadshow|ppt|presentation-projects)(?:\/|$)/.test(read.path)), "Team guidance must not read private profiles, trips or presentation artifacts").toEqual([]);
  expect(f.externalRequests, "Isolated browser tests must never reach external services").toEqual([]);
}

async function mockRead(page: Page, f: IsolatedWorkspace, path: string, data: unknown, status = 200) {
  await page.route(url => url.origin === f.origin && url.pathname === `/api/v1/${path}`, async route => {
    if (route.request().method() !== "GET") { await route.abort("blockedbyclient"); return; }
    await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" },
      body: JSON.stringify(status === 200 ? { data, requestId: "space-lifecycle-fixture" } : {
        error: { code: "FIXTURE_READ_UNAVAILABLE", message: "隔离夹具模拟读取失败，未产生任何外部请求。" }, requestId: "space-lifecycle-fixture",
      }),
    });
  });
}

function savedOperation(project: Project, owner: FixtureIdentity, commitSha: string, at: string): GitOperation {
  return {
    id: "fixture-current-save", projectId: project.id, actorId: owner.userId, bindingId: "fixture-binding", bindingRevision: 1,
    target: { repositoryId: 1, owner: "fixture-team", name: "fixture-repository", installationId: 2, appId: 3, defaultBranch: "main" },
    idempotencyKey: "fixture-current-save", inputHash: "fixture-input-hash", manifest: { entries: [], totalBytes: 0, inputHash: "fixture-input-hash", issues: [] },
    draftRef: "fixture-draft", expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), message: "隔离夹具：已保存新版本", wantsPullRequest: false,
    branch: "hackathon/fixture-current-save", status: "saved", step: "done", revision: 1, createdAt: at, updatedAt: at,
    preview: null, treeSha: "d".repeat(40), commitSha, commitMessage: null, pullRequestUrl: null, pullRequestStatus: "not_requested", errorCode: null, leaseUntil: null,
  };
}

function verification(project: Project, owner: FixtureIdentity, commitSha: string, at: string): DeliveryVerification {
  return {
    id: "fixture-old-version-passed", projectId: project.id, repositoryCommitSha: commitSha, verifierId: owner.userId, verifiedAt: at,
    environmentSummary: "隔离夹具环境，未运行真实仓库", steps: ["只提供旧版本运行记录夹具"], outcome: "passed", blockers: [],
    evidenceRefs: ["fixture:old-version-runtime-evidence"], verificationSource: "user_reported", version: 1,
  };
}

function emptySummary(project: Project): DeliverySummary {
  return {
    projectId: project.id,
    repository: { status: "not_saved", latestOperation: null, latestSavedOperation: null, mergeStatus: "not_verified" },
    runtime: { status: "unknown", currentCommitSha: null, matchStatus: "no_saved_commit", latestVerification: null, latestHistoricalVerification: null, verificationHistory: [] },
    submission: { records: [], platformConfirmationAvailable: false },
    requirements: { status: "not_loaded", recoveryAction: "review_confirmed_event_requirements" },
  };
}

function submission(project: Project, owner: FixtureIdentity, input: Pick<SubmissionRecord, "id" | "stageId" | "status"> & Partial<SubmissionRecord>): SubmissionRecord {
  const at = new Date(Date.now() - 30 * 60_000).toISOString();
  return {
    projectId: project.id, eventId: "fixture-event", requirementsVersion: "fixture-event:2:1", platformUrl: "https://example.test/fixture-submission",
    submittedAt: input.status === "not_submitted" ? null : at, verificationSource: "user_reported", repositoryCommitSha: null,
    evidenceRefs: ["fixture:member-submission-evidence"], recordedBy: owner.userId, recordedAt: at, version: 1, ...input,
  };
}

/** Typed M03 read fixture only. No event is published, source fetched, or real
 * official track invented; unknown official tracks remain omitted. */
function confirmedRules(project: Project, owner: FixtureIdentity): { confirmation: ProjectRuleConfirmation; rules: EventRuleVersion } {
  const at = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  return {
    confirmation: { projectId: project.id, eventId: "fixture-event", rulesVersion: 2, revision: 1, analysisId: null, confirmedBy: owner.userId, confirmedAt: at },
    rules: {
      eventId: "fixture-event", version: 2, createdAt: at,
      metadata: { name: "隔离规则夹具，不代表真实赛事", organizer: "隔离夹具", format: "unknown", region: "待核对", officialUrl: "https://example.test/fixture-rules" },
      sources: [{ id: "fixture-source", eventId: "fixture-event", version: 2, sourceConfigId: null, url: "https://example.test/fixture-rules", kind: "user_provided", contentHash: "fixture-only", fetchedAt: at, trustScope: "user_claim", status: "available" }],
      evidence: [{ id: "fixture-evidence", eventId: "fixture-event", version: 2, sourceId: "fixture-source", fieldKey: "submission", excerpt: "隔离夹具包含独立的作品、演示视频与补充材料阶段。", locator: "fixture-only", rawDateText: null, verifiedBy: null, verifiedAt: null, conflictsWith: [] }],
      facts: [],
      stages: [
        { id: "demo-round", stageType: "submission", name: "作品提交材料", startsAt: null, endsAt: null, submissionUrl: "https://example.test/fixture-demo" },
        { id: "video-round", stageType: "submission", name: "演示视频材料", startsAt: null, endsAt: null, submissionUrl: null },
        { id: "entry-round", stageType: "submission", name: "补充提交材料", startsAt: null, endsAt: null, submissionUrl: "https://example.test/fixture-entry" },
      ],
      requirements: [{ id: "fixture-general-material", label: "隔离夹具：作品说明", necessity: "required", stageId: null, evidenceIds: ["fixture-evidence"] }],
      qualityFlags: ["missing_information"],
    },
  };
}

test("375px new space shows a real next step and solo continuation; five stages only change the display", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("lifecycle-new-owner@example.test", "初次参赛的新人"), project = await createSpace(f, owner, false);
    const page = await f.page(owner, 375), reads = observeReads(page);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/app/projects/${project.id}`);
    const workbench = page.getByRole("region", { name: "参赛阶段工作台", exact: true });
    await expect(workbench).toBeVisible();
    await workbench.getByText("按阶段查看补充说明", { exact: true }).click();
    await expect(workbench.getByRole("tab")).toHaveCount(5);
    await expect(workbench.getByRole("tab", { name: stageLabels[0], exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(workbench.locator(`a[href="/app/projects/${project.id}#project-goal"]`).first()).toBeVisible();
    await expect(workbench).toContainText("一个人也能继续");
    await expect(workbench.getByText("建议先做", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toBeVisible();
    // An empty workspace starts with useful actions, not an empty task filter.
    await expect(page.getByRole("button", { name: "全队任务", exact: true })).toHaveCount(0);
    const before = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
    const localState = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
    for (const label of stageLabels) {
      const tab = workbench.getByRole("tab", { name: label, exact: true });
      await tab.click(); await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await workbench.getByRole("tab", { name: "演示与提交", exact: true }).click();
    await workbench.getByText("查看这个阶段的行动说明与可选工具", { exact: true }).click();
    const supplements = workbench.locator('details').filter({ has: page.getByText("按阶段查看补充说明", { exact: true }) }).first();
    await expect(supplements.locator('a[href^="/roadshow"]').first()).toHaveAttribute("href", `/roadshow?projectId=${encodeURIComponent(project.id)}`);
    await expect(supplements.locator('a[href^="/ppt"]').first()).toHaveAttribute("href", `/ppt?projectId=${encodeURIComponent(project.id)}`);
    await expect(workbench).toContainText(/讲稿|路演/);
    await expect(workbench).toContainText(/PPT|演示文稿/);
    await expect(workbench).toContainText(/私人|本人账号|不会自动共享/);
    for (const label of ["报名已完成", "PPT已完成", "出行已完成", "提交成功"]) await expect(workbench.getByText(label, { exact: true })).toHaveCount(0);
    await expect(workbench.getByRole("region", { name: "团队空间指引树", exact: true }).getByRole("checkbox")).toHaveCount(0);
    const after = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner);
    expect(after.project).toEqual(before.project);
    expect(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])))).toEqual(localState);
    expect(errors).toEqual([]); assertReadOnly(f, reads);
  } finally { await f.close(); }
});

test("a failed current-plan read stays unknown instead of becoming a no-plan result", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("lifecycle-plan-error@example.test", "读取计划的成员"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375), reads = observeReads(page);
    await mockRead(page, f, `projects/${project.id}/plans/current`, null, 503);
    await page.goto(`/app/projects/${project.id}`);
    const workbench = page.getByRole("region", { name: "参赛阶段工作台", exact: true });
    await workbench.getByText("选职责、填时间，确认分工与计划", { exact: true }).click();
    await expect(workbench).toContainText("任务计划读取失败，当前安排未知");
    await expect(workbench).toContainText(/未知|无法确认/);
    await expect(workbench).not.toContainText(/还没有生效计划|尚未有生效计划|当前没有生效计划/);
    await expect(page.getByRole("button", { name: "全队任务", exact: true })).toHaveCount(0);
    expect(reads.some(read => read.path === `projects/${project.id}/plans/current`)).toBe(true);
    assertReadOnly(f, reads);
  } finally { await f.close(); }
});

test("an old commit's passed runtime record cannot certify the newly saved version", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("lifecycle-old-commit@example.test", "核对版本的成员"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375), reads = observeReads(page), summary = emptySummary(project);
    const saved = savedOperation(project, owner, currentCommit, new Date(Date.now() - 10 * 60_000).toISOString());
    const historical = verification(project, owner, oldCommit, new Date(Date.now() - 60 * 60_000).toISOString());
    summary.repository = { status: "saved", latestOperation: saved, latestSavedOperation: saved, mergeStatus: "not_verified" };
    summary.runtime = { status: "not_verified", currentCommitSha: currentCommit, matchStatus: "no_matching_verification", latestVerification: null, latestHistoricalVerification: historical, verificationHistory: [historical] };
    await mockRead(page, f, `projects/${project.id}/delivery-summary`, summary);
    await page.goto(`/app/projects/${project.id}/delivery`);
    const checklist = page.getByRole("region", { name: "提交前核对清单", exact: true });
    await expect(checklist).toContainText(currentCommit.slice(0, 8));
    await expect(checklist).toContainText("当前已保存版本还没有对应的运行记录；旧版本或未填写版本的结果不能代替。");
    await expect(checklist).toContainText(/旧版本|其他版本|历史/);
    await expect(checklist).not.toContainText("成员记录当前已保存版本运行通过");
    await expect(checklist.getByText("提交成功", { exact: true })).toHaveCount(0);
    await expect(checklist.locator(`a[href="/app/projects/${project.id}/rules"]`).first()).toBeVisible();
    const saveLink = checklist.getByRole("link", { name: "查看保存操作与恢复方式 →", exact: true });
    await expect(saveLink).toHaveAttribute("href", `/app/projects/${project.id}/delivery#repository-save`);
    await saveLink.click();
    await expect(page).toHaveURL(url => url.hash === "#repository-save");
    await expect(page.locator("#repository-save")).toBeInViewport();
    await expect(page.locator("#repository-save").getByRole("heading", { name: "1 · 保存代码版本", exact: true })).toBeVisible();
    await expect(checklist.locator('a[href^="/roadshow"]').first()).toHaveAttribute("href", `/roadshow?projectId=${encodeURIComponent(project.id)}`);
    await expect(checklist.locator('a[href^="/ppt"]').first()).toHaveAttribute("href", `/ppt?projectId=${encodeURIComponent(project.id)}`);
    expect(reads.some(read => read.path === `projects/${project.id}/delivery-summary`)).toBe(true);
    assertReadOnly(f, reads);
  } finally { await f.close(); }
});

test("members see separate reported, not-submitted and withdrawn stages without reviving reported history or claiming success", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("lifecycle-submission-owner@example.test", "记录管理员"), member = await f.login("lifecycle-submission-member@example.test", "查看记录的队友"), project = await createSpace(f, owner);
    const invitation = await f.request<{ token: string }>(`projects/${project.id}/invitations`, "POST", { expectedRevision: project.revision, role: "member", maxUses: 1 }, owner, 201);
    await f.request(`invitations/${invitation.token}/accept`, "POST", {}, member);
    const page = await f.page(member, 375), reads = observeReads(page), summary = emptySummary(project);
    const oldReport = submission(project, owner, { id: "fixture-demo", stageId: "demo-round", status: "reported", version: 1 });
    const withdrawn = { ...oldReport, status: "rejected_or_withdrawn" as const, version: 2, recordedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    const video = submission(project, owner, { id: "fixture-video", stageId: "video-round", status: "reported" });
    const missing = submission(project, owner, { id: "fixture-entry", stageId: "entry-round", status: "not_submitted", submittedAt: null });
    const past = submission(project, owner, { id: "fixture-past", stageId: "past-round", status: "reported", requirementsVersion: "fixture-event:1:1", recordedAt: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString() });
    // The normal server DTO already collapses versions. An extra old revision
    // deliberately exercises defensive projection against historical revival.
    summary.submission.records = [video, oldReport, missing, past, withdrawn];
    await mockRead(page, f, `projects/${project.id}/delivery-summary`, summary);
    await mockRead(page, f, `projects/${project.id}/rules`, confirmedRules(project, owner));
    await page.goto(`/app/projects/${project.id}/delivery`);
    const checklist = page.getByRole("region", { name: "提交前核对清单", exact: true });
    await expect(checklist.getByRole("article", { name: "提交阶段：演示视频材料", exact: true })).toContainText("本阶段官方提交入口待核对");
    await expect(checklist.getByRole("article", { name: "提交阶段：作品提交材料", exact: true }).getByRole("link", { name: /^打开本阶段官方入口/ })).toHaveAttribute("href", "https://example.test/fixture-demo");
    await checklist.getByText("其它规则或阶段的提交历史（1）", { exact: true }).click();
    await expect(checklist.getByText("成员已报告提交", { exact: true })).toHaveCount(2);
    await expect(checklist.getByText("成员记录为未提交", { exact: true })).toHaveCount(1);
    await expect(checklist.getByText("成员记录为拒绝或撤回", { exact: true })).toHaveCount(1);
    for (const stageId of ["demo-round", "video-round", "entry-round", "past-round"]) await expect(checklist).toContainText(stageId);
    await expect(checklist).toContainText("fixture-event:1:1");
    await expect(checklist).toContainText(/自报|自行记录|成员记录/);
    for (const label of ["提交成功", "全部阶段已提交", "全部阶段提交完成", "平台核验已提交"]) await expect(checklist.getByText(label, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存验收记录", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "保存成员提交记录", exact: true })).toBeDisabled();
    assertReadOnly(f, reads);
  } finally { await f.close(); }
});

test("delivery-summary read failure reports unknown facts and offers a read-only recovery", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("lifecycle-delivery-error@example.test", "恢复读取的成员"), project = await createSpace(f, owner);
    const page = await f.page(owner, 375), reads = observeReads(page);
    let recovered = false;
    await page.route(url => url.origin === f.origin && url.pathname === `/api/v1/projects/${project.id}/delivery-summary`, async route => {
      if (route.request().method() !== "GET") { await route.abort("blockedbyclient"); return; }
      await route.fulfill({ status: recovered ? 200 : 503, contentType: "application/json", headers: { "Cache-Control": "private, no-store" },
        body: JSON.stringify(recovered ? { data: emptySummary(project), requestId: "space-lifecycle-recovered" } : { error: { code: "FIXTURE_READ_UNAVAILABLE", message: "隔离夹具读取失败。" }, requestId: "space-lifecycle-unavailable" }),
      });
    });
    await page.goto(`/app/projects/${project.id}/delivery`);
    const checklist = page.getByRole("region", { name: "提交前核对清单", exact: true });
    await expect(checklist.getByText("交付记录读取失败，当前结果未知", { exact: true })).toBeVisible();
    await expect(checklist).not.toContainText(/尚无提交记录|还没有提交记录|成员记录为未提交/);
    await expect(checklist.getByText("提交成功", { exact: true })).toHaveCount(0);
    recovered = true;
    await checklist.getByRole("button", { name: /重新读取|重试读取/ }).click();
    await expect(checklist.getByText("交付记录读取失败，当前结果未知", { exact: true })).toHaveCount(0);
    await expect(checklist).toContainText("没有可关联的已保存仓库版本");
    expect(reads.filter(read => read.path === `projects/${project.id}/delivery-summary`)).toHaveLength(2);
    assertReadOnly(f, reads);
  } finally { await f.close(); }
});

test("an archived space keeps its stage guide browsable and delivery actions read-only", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("lifecycle-archived@example.test", "查看归档的管理员"), project = await createSpace(f, owner);
    await f.request(`projects/${project.id}/stage`, "POST", { expectedRevision: project.revision, stage: "archived", reason: "隔离夹具：本轮准备已结束，保留历史" }, owner);
    const page = await f.page(owner, 375), reads = observeReads(page);
    await page.goto(`/app/projects/${project.id}`);
    const workbench = page.getByRole("region", { name: "参赛阶段工作台", exact: true });
    await expect(workbench).toContainText(/归档.*只读|只读.*归档/);
    await expect(page.getByRole("button", { name: "邀请队友", exact: true })).toHaveCount(0);
    await workbench.getByText("按阶段查看补充说明", { exact: true }).click();
    for (const label of stageLabels) {
      const tab = workbench.getByRole("tab", { name: label, exact: true });
      await expect(tab).toBeEnabled(); await tab.click(); await expect(tab).toHaveAttribute("aria-selected", "true");
    }
    await page.goto(`/app/projects/${project.id}/delivery`);
    const checklist = page.getByRole("region", { name: "提交前核对清单", exact: true });
    await expect(checklist).toContainText(/归档.*只读|只读.*归档/);
    await expect(page.getByRole("button", { name: "保存验收记录", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "保存成员提交记录", exact: true })).toBeDisabled();
    expect((await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, owner)).project.stage).toBe("archived");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    assertReadOnly(f, reads);
  } finally { await f.close(); }
});
