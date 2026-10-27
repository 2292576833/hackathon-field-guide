import { test, expect } from "@playwright/test";
import { isolatedWorkspace } from "./isolated-workspace.ts";

/** 验收：配色切换必须真的改变页面用色，并且记住选择（纯颜色变化，不改变结构与功能）。 */
test("the palette switcher changes real colors and remembers the choice", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const owner = await f.login("palette-owner@example.test", "配色验收");
    const page = await f.page(owner, 1280);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));

    await page.goto("/app");
    await page.waitForLoadState("networkidle");

    const readColors = () => page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        htmlClass: document.documentElement.className,
        paper: root.getPropertyValue("--paper").trim(),
        action: root.getPropertyValue("--action").trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });

    const before = await readColors();
    console.log("切换前:", JSON.stringify(before));

    // 切换器是页头里的普通元素（未登录也能看到），不做固定定位。
    const fab = page.locator(".paletteFab");
    await expect(fab).toBeVisible();
    await page.waitForTimeout(400);

    // 命中测试 + 不压住页头其它按钮：固定定位曾把「注册」压住，用户看不到入口。
    const report = await page.evaluate(() => {
      const target = document.querySelector(".paletteFab") as HTMLElement | null;
      if (!target) return { found: false as const };
      const rect = target.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const headerRects = [...document.querySelectorAll("header a, header button, header summary")]
        .filter(node => node !== target && !target.contains(node))
        .map(node => ({ text: (node.textContent || "").trim().slice(0, 12), rect: node.getBoundingClientRect() }))
        .filter(entry => entry.rect.width > 0)
        .filter(entry => !(entry.rect.right < rect.left || entry.rect.left > rect.right || entry.rect.bottom < rect.top || entry.rect.top > rect.bottom))
        .map(entry => entry.text);
      return { found: true as const, rect: { x: Math.round(rect.x), y: Math.round(rect.y) },
        hitClass: top ? String(top.className) : null, isSelf: top === target || (top !== null && target.contains(top)),
        overlaps: headerRects };
    });
    console.log("配色入口检查:", JSON.stringify(report));
    expect(report.found).toBe(true);
    if (report.found) {
      expect(report.isSelf, "配色入口必须能被点中").toBe(true);
      expect(report.overlaps, "配色入口不能压住页头其它按钮").toEqual([]);
    }

    await fab.click();

    // 展开的面板必须真的落在**视口内**（曾经因为绝对定位被锚到页面深处，画在视口外点不到）。
    const panel = page.locator(".paletteFabPanel");
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    const viewport = page.viewportSize()!;
    console.log("面板位置:", JSON.stringify(panelBox), "视口:", JSON.stringify(viewport));
    expect(panelBox).not.toBeNull();
    expect(panelBox!.y, "面板顶部必须在视口内").toBeLessThan(viewport.height);
    expect(panelBox!.x + panelBox!.width, "面板不能超出右边界").toBeLessThanOrEqual(viewport.width + 1);

    const target = page.getByRole("button", { name: /靛蓝/ });
    await expect(target).toBeVisible();
    await target.click();
    await page.waitForTimeout(300);

    const after = await readColors();
    console.log("切换后:", JSON.stringify(after));

    expect(after.paper, "--paper 必须真的变化").not.toBe(before.paper);
    expect(after.action, "--action 必须真的变化").not.toBe(before.action);
    expect(after.htmlClass, "必须挂上 palette-3").toContain("palette-3");
    expect(after.bodyBg, "页面背景必须跟着变").not.toBe(before.bodyBg);

    // 刷新后应记住选择
    await page.reload();
    await page.waitForLoadState("networkidle");
    const reloaded = await readColors();
    console.log("刷新后:", JSON.stringify(reloaded));
    expect(reloaded.htmlClass, "选择必须被记住").toContain("palette-3");
    expect(reloaded.paper).toBe(after.paper);

    // 切回第 1 套应移除 class（默认皮肤不挂 class）
    await page.locator(".paletteFab").click();
    await page.getByRole("button", { name: /暖白橙红/ }).click();
    await page.waitForTimeout(300);
    const restored = await readColors();
    console.log("切回默认:", JSON.stringify(restored));
    expect(restored.paper).toBe(before.paper);
    expect(restored.htmlClass).not.toContain("palette-3");

    expect(errors, "不应有未捕获异常").toEqual([]);
  } finally { await f.close(); }
});
