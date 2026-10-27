import { test, expect } from "./ux-test.ts";
import type { IsolatedWorkspace } from "./isolated-workspace.ts";
import type { Project } from "../../src/modules/projects/model.ts";

async function createSpace(f: IsolatedWorkspace, suffix: string) {
  const owner = await f.login(`space-loading-${suffix}@example.test`, "加载检查账号");
  const project = await f.request<Project>("projects", "POST", {
    name: "加载检查空间", timezone: "Asia/Shanghai", goal: "验证按需加载", minimumDeliverable: "能打开当前分区",
  }, owner, 201);
  return { owner, project, base: `/app/projects/${project.id}` };
}

test("closed space settings do not read teams/activity; first open mounts once and closing preserves input", async ({ workspace: f }) => {
  const { owner, project, base } = await createSpace(f, "settings");
  const page = await f.page(owner); await page.goto(base);
  await expect(page.locator("[data-instance-id]").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const settings = page.locator("#space-settings");
  const summary = settings.locator(":scope > summary");
  const settingsReads = () => f.apiReads.filter(read => read === "GET teams" || read === `GET projects/${project.id}/activity`);
  await expect(settings).not.toHaveAttribute("open", "");
  await expect(settings.locator("form")).toHaveCount(0);
  expect(settingsReads()).toEqual([]);

  await summary.click();
  const name = settings.getByLabel("新项目名称", { exact: true });
  await expect(name).toBeVisible();
  await expect.poll(settingsReads).toHaveLength(2);
  await name.fill("尚未提交的下次项目");
  await summary.click(); await expect(name).toBeHidden();
  await summary.click(); await expect(name).toHaveValue("尚未提交的下次项目");
  expect(settingsReads()).toHaveLength(2);
  expect(f.apiReads.filter(read => read.endsWith("/clone"))).toEqual([]);
  expect(f.externalRequests).toEqual([]);
});

test("space settings hash opens the deferred controls", async ({ workspace: f }) => {
  const { owner, base } = await createSpace(f, "settings-hash");
  const page = await f.page(owner); await page.goto(`${base}#space-settings`);
  await expect(page.locator("#space-settings")).toHaveAttribute("open", "");
  await expect(page.locator("#space-settings").getByLabel("新项目名称", { exact: true })).toBeVisible();
  expect(f.externalRequests).toEqual([]);
});

const sections = [
  { section: "team", heading: "一起参赛的队友" },
  { section: "rules", heading: "本次参加哪个官方赛道" },
  { section: "assessment", heading: "先选自己愿意做的事" },
  { section: "plan", heading: "当前任务计划" },
  { section: "delivery", heading: "2 · 记录一次真实运行" },
  { section: "resources", heading: "空间资料" },
  { section: "retrospective", heading: "经验卡与选择性复用" },
] as const;

for (const { section, heading } of sections) {
  test(`direct ${section} navigation loads its deferred editor without mounting space settings`, async ({ workspace: f }) => {
    const { owner, project, base } = await createSpace(f, section);
    const page = await f.page(owner);
    const failures: string[] = [];
    page.on("pageerror", error => failures.push(error.name));
    await page.goto(`${base}/${section}`);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "← 返回团队空间", exact: true })).toHaveAttribute("href", base);
    await expect(page.locator("#space-settings")).toHaveCount(0);
    expect(f.apiReads).not.toContain(`GET projects/${project.id}/activity`);
    expect(failures).toEqual([]);
    expect(f.externalRequests).toEqual([]);
  });
}
