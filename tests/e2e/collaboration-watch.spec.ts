import { test, expect } from "./ux-test.ts";
import type { IsolatedWorkspace } from "./isolated-workspace.ts";
import type { Project } from "../../src/modules/projects/model.ts";
import type { DocumentDraft, DocumentDraftCollection } from "../../src/modules/document-drafts/index.ts";
import type { SpaceDocument } from "../../src/server/space-documents.ts";
import type { SpaceChangesList } from "../../src/modules/space-changes/index.ts";

async function setup(f: IsolatedWorkspace, key: string) {
  const owner = await f.login(`watch-${key}-owner@example.test`,"小林");
  const member = await f.login(`watch-${key}-member@example.test`,"小周");
  const project = await f.request<Project>("projects","POST",{name:`协作护航-${key}`,timezone:"Asia/Shanghai",goal:"做可打开的核心演示",minimumDeliverable:"一个完整使用流程"},owner,201);
  const api = `projects/${project.id}`, base = `/app/projects/${project.id}`;
  async function join() {
    const detail = await f.request<{project:Project}>(api,"GET",undefined,owner);
    const invite = await f.request<{token:string}>(`${api}/invitations`,"POST",{expectedRevision:detail.project.revision,maxUses:1},owner,201);
    await f.request(`invitations/${invite.token}/accept`,"POST",{},member);
  }
  return {owner,member,project,api,base,join};
}
function noRealAi(f: IsolatedWorkspace) {
  expect(f.externalRequests).toEqual([]);
  expect(f.apiReads.filter(value => /^(POST|PUT) .*\/(?:assistant\/messages|feasibility)(?:$|\/)/.test(value))).toEqual([]);
}

test("an invited member appears in both compact rosters without reloading the original page", async ({workspace:f}) => {
  const s = await setup(f,"roster"), page = await f.page(s.owner,375);
  await page.goto(s.base);
  const roster = page.locator("#space-teammates");
  await expect(roster.getByRole("list").first().locator(":scope > li")).toHaveCount(1);
  await expect(roster.getByText("我",{exact:true})).toBeVisible();
  await s.join();
  await expect(roster.getByRole("list").first().locator(":scope > li")).toHaveCount(2,{timeout:25_000});
  await expect(page.getByRole("button",{name:"队友 2",exact:true})).toBeVisible();
  await expect(roster.getByText("小周",{exact:true})).toBeVisible();
  const other = await f.page(s.member,375); await other.goto(s.base);
  await expect(other.locator("#space-teammates").getByRole("list").first().locator(":scope > li")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1)).toBeTruthy();
  noRealAi(f);
});

test("a phone user's private draft restores after refresh and is shared only after explicit save", async ({workspace:f}) => {
  const s = await setup(f,"draft"); await s.join();
  const page = await f.page(s.owner,375); await page.goto(s.base);
  const body = "演示脚本第1版\n先打开核心流程，再按检查清单演示。";
  const editor = page.getByRole("textbox",{name:"新文档正文",exact:true});
  await expect(editor).toBeVisible(); await editor.fill(body);
  await expect.poll(async () => (await f.request<DocumentDraft>(`${s.api}/document-drafts/new`,"GET",undefined,s.owner)).body).toBe(body);
  await expect(page.getByText("已保护私人草稿，尚未保存到团队。",{exact:true})).toBeVisible();
  expect((await f.request<DocumentDraftCollection>(`${s.api}/document-drafts`,"GET",undefined,s.member)).items).toEqual([]);
  expect((await f.request<SpaceDocument[]>(`${s.api}/space-documents`,"GET",undefined,s.member))).toEqual([]);
  await page.reload(); await expect(editor).toHaveValue(body);
  const form = editor.locator("xpath=ancestor::form");
  await form.locator("[data-space-document-menu] > summary").click();
  await form.getByRole("button",{name:"保存",exact:true}).click();
  await expect.poll(async () => (await f.request<SpaceDocument[]>(`${s.api}/space-documents`,"GET",undefined,s.member)).map(item=>item.body)).toEqual([body]);
  await expect(page.getByText("正文已保存，本空间成员可以阅读。",{exact:true})).toBeVisible();
  const docs = await f.request<SpaceDocument[]>(`${s.api}/space-documents`,"GET",undefined,s.owner);
  await expect(page.locator(`#space-document-${docs[0]!.id}`).locator("[data-space-document-text]")).toHaveText(body);
  noRealAi(f);
});

test("a teammate explicitly acknowledges a goal change while their task and plan facts stay intact", async ({workspace:f}) => {
  const s = await setup(f,"change"); await s.join();
  await f.request(`${s.api}/space-changes/reconcile`,"POST",{},s.owner);
  const detail = await f.request<{project:Project}>(s.api,"GET",undefined,s.owner);
  await f.request(s.api,"PATCH",{expectedRevision:detail.project.revision,goal:"先做更小的核心演示"},s.owner);
  const before = await f.request(`${s.api}/plans/current`,"GET",undefined,s.member);
  const page = await f.page(s.member,375); await page.goto(s.base);
  await page.locator("#space-changes").getByRole("button",{name:/关键变更/}).click();
  await expect(page.locator("#space-changes").getByText("先做更小的核心演示",{exact:true})).toBeVisible();
  await page.locator("#space-changes").getByRole("button",{name:"我已了解",exact:true}).click();
  await expect.poll(async () => (await f.request<SpaceChangesList>(`${s.api}/space-changes`,"GET",undefined,s.member)).pendingCount).toBe(0);
  expect(await f.request(`${s.api}/plans/current`,"GET",undefined,s.member)).toEqual(before);
  expect((await f.request<SpaceChangesList>(`${s.api}/space-changes`,"GET",undefined,s.owner)).pendingCount).toBe(1);
  noRealAi(f);
});
