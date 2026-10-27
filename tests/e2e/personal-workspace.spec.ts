import { test, expect } from "./ux-test.ts";

test.beforeEach(async ({page})=>{
  await page.addInitScript(()=>localStorage.setItem("hackathon-navigator-intro-2026-10-09-v2","seen"));
});
for (const width of [375,1280]) {
  test(`public registration, roadshow, PPT and personal-plan guidance remain usable at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    for(const path of ["/register","/roadshow","/ppt","/participation"]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
      const nav=page.getByRole("navigation",{name:"主导航",exact:true});
      await expect(nav.getByRole("link")).toHaveText(["参赛指引","找比赛","我的参赛","工具与资料"]);
      await expect(nav.getByRole("link",{name:"我的参赛",exact:true})).toHaveAttribute("href","/app");
      if(path==="/roadshow"||path==="/ppt") await expect(page.getByRole("navigation",{name:"准备展示材料",exact:true})).toBeVisible();
      if(path==="/ppt") {
        await expect(page.locator("#ppt-templates")).not.toHaveAttribute("open", "");
        await page.locator("#ppt-templates > summary").click();
        await page.locator("#ppt-tools > summary").click();
        await expect(page.getByRole("link",{name:/Microsoft PowerPoint/})).toHaveAttribute("href","https://www.microsoft.com/en-us/microsoft-365/powerpoint");
        await expect(page.getByRole("button",{name:"下载原创 Markdown 框架"})).toBeEnabled();
      }
      if(path==="/roadshow") {
        await expect(page.locator("#roadshow-examples")).not.toHaveAttribute("open", "");
        await page.getByRole("link", {name:"先看原创案例", exact:true}).click();
        await expect(page.locator("#roadshow-examples")).toHaveAttribute("open", "");
        await expect(page.locator("#roadshow-examples > summary")).toBeFocused();
      }
    }
    expect(errors).toEqual([]);
  });
}
test("event plan link preserves the actual selected event through the login flow without a guest model request",async({page,workspace})=>{
  const now=new Date().toISOString(),url="https://events.example.com/isolated-plan-context";
  await workspace.app.discoveries.save({canonicalUrl:url,title:"隔离参赛计划入口夹具",summary:"仅用于浏览器上下文验收，不代表真实赛事。",analysis:{fit:["先核对规则"],risks:["报名条件待核对"],preparation:["准备一个最小作品"],unknowns:["地点未提供"]},sources:[{url,title:"隔离公开说明",excerpt:"用于确认选中比赛的上下文保留。",fetchedAt:now}],discoveredAt:now,lastAnalyzedAt:now,provider:"dsh"});
  let modelCalls=0;page.on("request",request=>{if(request.method()==="POST"&&request.url().includes("/me/participation/plans"))modelCalls++;});
  await page.goto("/events");
  await page.getByText("展开比赛信息与建议", { exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "选好这场比赛后，开始准备", exact: true }).first()).toBeVisible();
  const planLink=page.getByRole("link",{name:"制定我的参赛计划"}).first();
  await expect(planLink).toBeVisible();
  const href=await planLink.getAttribute("href");expect(href).toMatch(/^\/participation\?event=[a-f0-9]{64}$/);
  const contextRequest=page.waitForRequest(request=>request.url().includes("/me/participation/context?eventId="));
  await planLink.click();
  const selected=await contextRequest;expect(new URL(selected.url()).searchParams.get("eventId")).toBe(new URL(href!,"http://localhost").searchParams.get("event"));
  await expect(page.getByRole("heading",{name:"登录后开始准备"})).toBeVisible();
  const login=page.getByRole("link",{name:/登录后继续|登录并继续/}).first();
  await expect(login).toHaveAttribute("href",`/login?returnTo=${encodeURIComponent(href!)}`);
  expect(modelCalls).toBe(0);
});
