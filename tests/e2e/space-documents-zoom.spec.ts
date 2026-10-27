import { test, expect } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import { isolatedWorkspace } from "./isolated-workspace.ts";

/**
 * 用户报：文档组件无法放大缩小。
 *
 * 根因：空间文档卡片**默认就是编辑态**，正文 `textarea` 占满整张卡且内部不滚动；
 * 而原规则把 `editor` 区域一律排除在滚轮缩放之外，于是鼠标落在正文上滚轮毫无反应——
 * 那张卡几乎无处可缩。
 *
 * 修复：编辑区内部**没有可滚动内容**时允许缩放；内部还有内容可滚时仍以原生滚动优先。
 */
test("documents card zooms with the wheel even over its editor body", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const me = await f.login("doc-zoom-fix@example.test", "文档缩放验收");
    const project = await f.request<Project>("projects", "POST", {
      name: "文档缩放验收空间", timezone: "Asia/Shanghai", goal: "验证文档卡可缩放",
      minimumDeliverable: "可演示", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
    }, me, 201);
    await f.request(`projects/${project.id}/space-documents`, "POST", { title: "验收文档", body: "验收正文，用来确认滚轮可以缩放。" }, me, 201).catch(() => {});

    const page = await f.page(me, 1440);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(`/app/projects/${project.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(900);

    const card = page.locator("[data-instance-id][data-component-kind='documents']");
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const box = (await card.boundingBox())!;

    // 先确认正文确实是编辑框（把根因固定下来，避免以后改回只读时这条测试失去意义）
    const hit = await page.evaluate((point) => {
      const node = document.elementFromPoint(point.x, point.y) as HTMLElement | null;
      return { tag: node?.tagName.toLowerCase() ?? null, isEditor: !!node?.closest("textarea,input,select,[contenteditable]:not([contenteditable=false]),[role=textbox]") };
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    console.log("正文中心命中:", JSON.stringify(hit));

    // 框选文档卡
    await page.mouse.move(box.x - 20, Math.max(300, box.y - 20));
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 40, box.y + Math.min(box.height, 400) + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await expect(page.locator("[data-instance-id][data-component-kind='documents']"), "文档卡应能被框选").toHaveAttribute("data-selected", "true");

    const readScale = () => page.evaluate(() => {
      const node = document.querySelector("[data-instance-id][data-component-kind='documents']") as HTMLElement | null;
      const match = node?.style.transform.match(/scale\(([\d.]+)\)/);
      return match ? Number(match[1]) : 1;
    });

    // 滚轮落在**正文中央**——这正是原来完全没反应的位置
    const inner = (await card.boundingBox())!;
    await page.mouse.move(inner.x + inner.width / 2, inner.y + inner.height / 2);
    const before = await readScale();
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(350);
    const afterUp = await readScale();
    console.log(`正文中央滚轮: scale ${before} -> ${afterUp}`);
    expect(afterUp, "滚轮落在文档正文上也应能放大").toBeGreaterThan(before);

    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(350);
    const afterDown = await readScale();
    console.log(`正文中央反向滚轮: scale ${afterUp} -> ${afterDown}`);
    expect(afterDown, "反向滚轮应能缩小").toBeLessThan(afterUp);

    expect(errors, "不应有未捕获异常").toEqual([]);
  } finally { await f.close(); }
});
