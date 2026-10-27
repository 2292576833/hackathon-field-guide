import { test, expect } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import type { PlanVersion, PlanningInput, TaskProposal, TaskKind, CurrentPlanningView } from "../../src/modules/planning/types.ts";
import type { ProjectDetail } from "../../src/components/projects-client.tsx";
import { isolatedWorkspace, type FixtureIdentity } from "./isolated-workspace.ts";

const remainingEstimate = { optimisticMinutes: 5, likelyMinutes: 10, pessimisticMinutes: 15, basis: "隔离夹具人工试做估算" };

async function space(f: Awaited<ReturnType<typeof isolatedWorkspace>>) {
  const manager = await f.login("helper-vis-manager@example.test", "管理员");
  const owner = await f.login("helper-vis-owner@example.test", "负责队友");
  const helper = await f.login("helper-vis-helper@example.test", "协助队友");
  // 逐步打印，便于定位 INVALID_INPUT 到底来自哪一步（不靠猜）。
  const step = async <T>(label: string, path: string, method: string, body: unknown, identity: FixtureIdentity, expected = 200): Promise<T> => {
    const response = await f.raw(path, method, body, identity);
    const text = await response.text();
    if (response.status !== expected) console.log(`步骤失败 ${label}: HTTP ${response.status} ${text.slice(0, 300)}`);
    else console.log(`步骤通过 ${label}: HTTP ${response.status}`);
    expect(response.status, `${label}: ${text.slice(0, 200)}`).toBe(expected);
    return JSON.parse(text).data as T;
  };
  const project = await step<Project>("建空间", "projects", "POST", {
    name: "协助可见性验收空间", timezone: "Asia/Shanghai", goal: "验证协助者在队友状态里可见",
    minimumDeliverable: "可演示的最小版本",
    deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
  }, manager, 201);
  const before = await step<ProjectDetail>("读空间", `projects/${project.id}`, "GET", undefined, manager);
  const invitation = await step<{ token: string }>("建邀请", `projects/${project.id}/invitations`, "POST", {
    expectedRevision: before.project.revision, role: "member", maxUses: 2,
  }, manager, 201);
  for (const [name, peer] of [["负责队友", owner], ["协助队友", helper]] as const) {
    await step(`接受邀请-${name}`, `invitations/${invitation.token}/accept`, "POST", {}, peer);
  }

  const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const endsAt = new Date(Date.now() + 9 * 60 * 60_000).toISOString();
  for (const [name, peer] of [["管理员", manager], ["负责队友", owner], ["协助队友", helper]] as const) {
    await step(`可用时间-${name}`, `projects/${project.id}/my-availability`, "PUT", {
      expectedRevision: 0, timezone: "UTC", windows: [{ id: `w-${peer.userId}`, startsAt, endsAt, effectiveMinutes: 480 }],
    }, peer);
  }

  const detail = await step<ProjectDetail>("读成员", `projects/${project.id}`, "GET", undefined, manager);
  const input = await step<PlanningInput>("读计划输入", `projects/${project.id}/planning-input`, "GET", undefined, manager);
  console.log("计划输入: deadlines=" + input.deadlines.length + " requiredTaskKinds=" + JSON.stringify(input.requiredTaskKinds));
  const membership = (peer: FixtureIdentity) => detail.members.find(member => member.userId === peer.userId)!.membershipId;

  const proposal = (id: string, kind: TaskKind, peer: FixtureIdentity, helpers: string[] = []): TaskProposal => ({
    id, projectId: project.id, title: `验收任务 ${id}`, priority: "must", kind, ownerMembershipId: membership(peer),
    helperEfforts: helpers.map(value => ({ membershipId: value, durationEstimate: remainingEstimate })),
    deliverable: "可查看可检查的成果", acceptanceCriteria: ["可按说明复现"], reviewerMembershipId: membership(manager),
    durationEstimate: remainingEstimate, dependencyTaskIds: [], deadlineRef: input.deadlines[0]!.id,
    requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0,
  });
  const tasks: TaskProposal[] = [proposal("t-helper", "implementation", owner, [membership(helper)])];
  for (const kind of input.requiredTaskKinds) if (!tasks.some(value => value.kind === kind)) tasks.push(proposal(`t-req-${kind}`, kind, manager));

  const draft = await step<PlanVersion>("建计划草案", `projects/${project.id}/plan-versions`, "POST", {
    tasks, buffers: [], reason: "验证协助可见性", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "helper-vis-draft",
  }, manager, 201);
  if (draft.status !== "ready") throw new Error(`draft not ready: ${JSON.stringify(draft.validation?.issues?.slice(0, 3))}`);
  await step("确认计划", `projects/${project.id}/plan-versions/${draft.id}/apply`, "POST", {
    expectedRevision: draft.revision,
    acknowledgedIssueCodes: [...new Set(draft.validation!.issues.map(issue => issue.code))], idempotencyKey: "helper-vis-apply",
  }, manager);
  return { project, manager, owner, helper, helperMembershipId: membership(helper) };
}

test("a helper who is not the owner is visible in the teammates panel", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const { project, owner, helper, helperMembershipId } = await space(f);
    const page = await f.page(owner, 1280);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));

    await page.goto(`/app/projects/${project.id}`);
    await page.waitForLoadState("networkidle");

    // 队友状态默认在画布上（默认布局含 teammates）；等它渲染出「协助队友」。
    const panel = page.locator("#space-teammates");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const helperCard = panel.locator("li").filter({ hasText: "协助队友" }).first();
    await expect(helperCard, "协助者应出现在队友状态里").toBeVisible();
    await helperCard.locator("summary").click();
    const text = await helperCard.innerText();
    console.log("协助者卡片内容:", JSON.stringify(text.replace(/\s+/g, " ").slice(0, 300)));

    // 此前协助者完全隐身、状态落到「暂无安排」；现在应为「正在协助」并列出该任务。
    expect(text, "应显示协助状态而不是「暂无安排」").toContain("正在协助");
    expect(text, "应列出协助的任务").toContain("验收任务 t-helper");
    expect(text).not.toContain("暂无安排");

    expect(errors, "不应有未捕获异常").toEqual([]);

    // 反面校验：该任务确实属于 owner，而不是 helper 负责——避免把「负责人」误当「协助者」。
    const current = await f.request<CurrentPlanningView>(`projects/${project.id}/plans/current`, "GET", undefined, helper);
    const task = current.tasks.find(value => value.id === "t-helper")!;
    expect(task.ownerMembershipId).not.toBe(helperMembershipId);
    expect(task.helperEfforts!.map(value => value.membershipId)).toContain(helperMembershipId);
  } finally { await f.close(); }
});
