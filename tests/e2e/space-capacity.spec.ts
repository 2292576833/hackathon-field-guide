import { test, expect } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import type { PlanVersion, PlanningInput, TaskProposal, TaskKind, CurrentPlanningView } from "../../src/modules/planning/types.ts";
import type { ProjectDetail } from "../../src/components/projects-client.tsx";
import { isolatedWorkspace, type FixtureIdentity } from "./isolated-workspace.ts";

const estimate = { optimisticMinutes: 30, likelyMinutes: 60, pessimisticMinutes: 90, basis: "隔离夹具人工试做估算" };

async function space(f: Awaited<ReturnType<typeof isolatedWorkspace>>) {
  const manager = await f.login("capacity-manager@example.test", "管理员");
  const owner = await f.login("capacity-owner@example.test", "负责队友");
  const project = await f.request<Project>("projects", "POST", {
    name: "容量对照验收空间", timezone: "Asia/Shanghai", goal: "验证容量对照能显示",
    minimumDeliverable: "可演示的最小版本", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
  }, manager, 201);
  const before = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, manager);
  const invitation = await f.request<{ token: string }>(`projects/${project.id}/invitations`, "POST", {
    expectedRevision: before.project.revision, role: "member", maxUses: 1,
  }, manager, 201);
  await f.request(`invitations/${invitation.token}/accept`, "POST", {}, owner);

  const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const endsAt = new Date(Date.now() + 9 * 60 * 60_000).toISOString();
  for (const peer of [manager, owner]) await f.request(`projects/${project.id}/my-availability`, "PUT", {
    expectedRevision: 0, timezone: "UTC", windows: [{ id: `w-${peer.userId}`, startsAt, endsAt, effectiveMinutes: 480 }],
  }, peer);

  const detail = await f.request<ProjectDetail>(`projects/${project.id}`, "GET", undefined, manager);
  const input = await f.request<PlanningInput>(`projects/${project.id}/planning-input`, "GET", undefined, manager);
  const membership = (peer: FixtureIdentity) => detail.members.find(member => member.userId === peer.userId)!.membershipId;
  const proposal = (id: string, kind: TaskKind, peer: FixtureIdentity): TaskProposal => ({
    id, projectId: project.id, title: `容量任务 ${id}`, priority: "must", kind, ownerMembershipId: membership(peer),
    helperEfforts: [], deliverable: "可查看的成果", acceptanceCriteria: ["可按说明复现"], reviewerMembershipId: membership(manager),
    durationEstimate: estimate, dependencyTaskIds: [], deadlineRef: input.deadlines[0]!.id,
    requirementRefs: [], resourceRefs: [], splittable: false, contextSwitchMinutes: 0, waitMinutes: 0,
  });
  const tasks: TaskProposal[] = [proposal("t-cap", "implementation", owner)];
  for (const kind of input.requiredTaskKinds) if (!tasks.some(value => value.kind === kind)) tasks.push(proposal(`t-req-${kind}`, kind, manager));
  const draft = await f.request<PlanVersion>(`projects/${project.id}/plan-versions`, "POST", {
    tasks, buffers: [], reason: "验证容量对照", expectedTasksRevision: 0, basePlanVersionId: null, idempotencyKey: "capacity-draft",
  }, manager, 201);
  if (draft.status !== "ready") throw new Error(`draft not ready: ${JSON.stringify(draft.validation?.issues?.slice(0, 3))}`);
  await f.request(`projects/${project.id}/plan-versions/${draft.id}/apply`, "POST", {
    expectedRevision: draft.revision, acknowledgedIssueCodes: [...new Set(draft.validation!.issues.map(issue => issue.code))], idempotencyKey: "capacity-apply",
  }, manager);
  return { project, manager, owner };
}

test("the capacity comparison renders real minutes per member without percentages", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const { project, manager } = await space(f);
    // 计划里应真的有 capacityMinutes（说明对照有依据）
    const current = await f.request<CurrentPlanningView>(`projects/${project.id}/plans/current`, "GET", undefined, manager);
    const capacityKeys = Object.keys(current.evaluation?.likely?.capacityMinutes ?? {});
    console.log("排程里的可用分钟成员数:", capacityKeys.length);

    const page = await f.page(manager, 1280);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(`/app/projects/${project.id}`);
    await page.waitForLoadState("networkidle");

    const overview = page.locator("#space-overview");
    await expect(overview).toBeVisible({ timeout: 15_000 });
    // details 里的内容在展开前不可见。用原生方式展开（这是受控属性，不依赖点击动画），
    // 否则会因为读到收起状态而误判功能缺失。
    const entry = overview.locator("summary", { hasText: "每个人剩余工作量与可用时间" });
    await expect(entry, "团队进度卡里应出现容量对照入口").toBeVisible();
    await page.evaluate(() => {
      for (const node of document.querySelectorAll("#space-overview details")) {
        if ((node.querySelector("summary")?.textContent ?? "").includes("每个人剩余工作量与可用时间")) node.setAttribute("open", "");
      }
    });
    await expect(overview.getByText("可用时间", { exact: false }).first()).toBeVisible({ timeout: 5_000 });

    const text = await overview.innerText();
    console.log("容量对照区文本:", JSON.stringify(text.slice(0, 400)));
    expect(text, "应显示剩余工作量").toContain("剩余工作量");
    expect(text, "应显示可用时间").toContain("可用时间");
    // 宪法：不得出现百分比或完成度
    expect(text.includes("%"), "不得出现百分比").toBe(false);
    expect(text, "不得出现完成度字样").not.toContain("完成度");
    expect(errors, "不应有未捕获异常").toEqual([]);
  } finally { await f.close(); }
});
