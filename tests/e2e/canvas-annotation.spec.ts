import { test, expect } from "@playwright/test";
import type { Project } from "../../src/modules/projects/model.ts";
import { isolatedWorkspace } from "./isolated-workspace.ts";

/**
 * 画布右击快捷栏 + 画笔/橡皮（用户 2026-10-13 要求）。
 *
 * 为什么先滚到组件下方：默认布局的组件铺满可见区域，合成鼠标事件会落在卡片上、
 * 到不了画布面（实测 elementFromPoint 是 SECTION.card）。只有真正的空白处才验证得了画笔与橡皮。
 *
 * 验收点：
 *  1. 右击空白出现快捷栏，含加组件/批注工具/画布视图；
 *  2. 画笔能画、橡皮能整笔擦掉；
 *  3. **批注模式不破坏原有手势**：退出批注后组件仍能长按拖动。
 */

/** 滚到组件最下方，然后返回一处确实是画布面的点。 */
async function blankCanvasPoint(page: import("@playwright/test").Page, exclude?: { x: number; y: number; width: number; height: number }) {
  const lowest = await page.evaluate(() => {
    let bottom = 0;
    for (const node of document.querySelectorAll("[data-instance-id]")) bottom = Math.max(bottom, node.getBoundingClientRect().bottom + window.scrollY);
    return Math.round(bottom);
  });
  await page.evaluate((y: number) => window.scrollTo({ top: y }), lowest + 40);
  await page.waitForTimeout(350);
  return page.evaluate((box) => {
    for (let y = 360; y < window.innerHeight - 80; y += 16) {
      for (let x = 60; x < window.innerWidth - 80; x += 16) {
        const node = document.elementFromPoint(x, y) as HTMLElement | null;
        const insideExcluded = box && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
        if (!insideExcluded && node?.hasAttribute("data-mobile")) return { x, y };
      }
    }
    return null;
  }, exclude ?? null);
}

test("canvas right-click menu, pen and eraser work without breaking existing gestures", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const me = await f.login("canvas-annotate@example.test", "批注验证");
    const project = await f.request<Project>("projects", "POST", {
      name: "画布批注验收空间", timezone: "Asia/Shanghai", goal: "验证右击栏与画笔",
      minimumDeliverable: "可演示", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
    }, me, 201);
    const page = await f.page(me, 1440);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(`/app/projects/${project.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);

    const point = await blankCanvasPoint(page);
    expect(point, "应能在组件下方找到画布空白点").not.toBeNull();
    console.log("画布点:", JSON.stringify(point));

    // 1) 右击空白 → 快捷栏
    await page.mouse.click(point!.x, point!.y, { button: "right" });
    const menu = page.locator("[role='menu']").first();
    await expect(menu, "右击应弹出快捷栏").toBeVisible({ timeout: 5_000 });
    const menuText = await menu.innerText();
    console.log("右击栏内容:", JSON.stringify(menuText.replace(/\s+/g, " ").slice(0, 400)));
    for (const expected of ["加组件", "批注", "画笔", "荧光笔", "箭头", "文字便签", "橡皮", "清空笔迹", "画布视图", "重置视图", "缩放回 100%", "整理布局", "取消批注"]) {
      expect(menuText, `右击栏应包含「${expected}」`).toContain(expected);
    }

    // 2) 选画笔 → 画一笔
    await menu.getByRole("menuitem", { name: "画笔" }).click();
    const bar = page.locator("[class*='annotationBar']").first();
    await expect(bar, "选工具后应出现浮动工具条").toBeVisible();

    const layer = page.locator("[class*='annotationLayer']").first();
    const from = { x: point!.x + 30, y: point!.y + 30 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(from.x + step * 14, from.y + step * 4);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const drawn = await layer.locator("polyline").count();
    console.log("画完之后的笔迹数:", drawn);
    expect(drawn, "画笔应留下笔迹").toBeGreaterThan(0);

    // 3) 橡皮：用笔迹首点的精确屏坐标，并先确认该点确实是画布面
    const drop = await page.evaluate(() => {
      const svg = document.querySelector("[class*='annotationLayer']") as SVGSVGElement | null;
      const points = svg?.querySelector("polyline")?.getAttribute("points") ?? null;
      if (!svg || !points) return { error: "没有笔迹" };
      const first = points.trim().split(/\s+/)[0] ?? "";
      const [rawX, rawY] = first.split(",");
      const cx = Number(rawX), cy = Number(rawY);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { error: "坐标无法解析", first };
      const box = svg.getBoundingClientRect();
      const scaleX = svg.offsetWidth > 0 ? box.width / svg.offsetWidth : 1;
      const scaleY = svg.offsetHeight > 0 ? box.height / svg.offsetHeight : 1;
      const x = box.left + cx * scaleX, y = box.top + cy * scaleY;
      const node = document.elementFromPoint(x, y) as HTMLElement | null;
      return { x, y, topmost: node?.className ?? "(null)", onCanvas: !!node?.hasAttribute("data-mobile") };
    });
    console.log("橡皮点位:", JSON.stringify(drop));
    expect(drop && !("error" in drop), `应能算出笔迹首点：${JSON.stringify(drop)}`).toBe(true);
    expect((drop as { onCanvas: boolean }).onCanvas, `橡皮点位必须在画布面上，实际 ${(drop as { topmost: string }).topmost}`).toBe(true);

    await bar.getByRole("button", { name: "橡皮" }).click();
    await page.mouse.move((drop as { x: number }).x, (drop as { y: number }).y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(300);
    const afterErase = await layer.locator("polyline").count();
    console.log("擦除之后的笔迹数:", afterErase);
    expect(afterErase, "橡皮应整笔擦掉笔迹").toBeLessThan(drawn);

    // 4) 「取消批注」＝取消当前选中的工具：**保留**已画好的笔迹，只是不再处于绘制状态
    await bar.getByRole("button", { name: "取消批注（取消选中的工具）" }).click();
    await expect(page.locator("[class*='annotationBar']"), "取消工具后工具条应收起").toHaveCount(0);
    const kept = await layer.locator("polyline").count();
    console.log("取消工具后保留的笔迹数:", kept);
    expect(kept, "取消批注只是取消工具，不得删掉笔迹").toBe(afterErase);

    // 5) 清空笔迹才是真的删内容
    await page.mouse.click(point!.x, point!.y, { button: "right" });
    const menuAgain = page.locator("[role='menu']").first();
    await expect(menuAgain).toBeVisible();
    // 先丢弃刚才擦剩下的一笔之外的内容：这里用「清空笔迹」按钮
    const clearButton = menuAgain.getByRole("menuitem", { name: "清空笔迹" });
    if (await clearButton.isEnabled()) {
      await clearButton.click();
      await page.waitForTimeout(300);
      const cleared = await page.evaluate(() => {
        const svg = document.querySelector("[class*='annotationLayer']") as SVGSVGElement | null;
        return svg ? svg.querySelectorAll("polyline").length : 0;
      });
      console.log("清空后笔迹数:", cleared);
      expect(cleared, "清空笔迹应真的删掉内容").toBe(0);
    } else {
      await page.keyboard.press("Escape");
    }

    const card = page.locator("[data-instance-id]").first();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const cardBox = (await card.boundingBox())!;
    await page.mouse.move(cardBox.x + 30, cardBox.y + 8);
    await page.mouse.down();
    await page.waitForTimeout(700); // 长按阈值
    await page.mouse.move(cardBox.x + 140, cardBox.y + 90, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const movedBox = (await card.boundingBox())!;
    console.log("长按拖动:", JSON.stringify({ before: { x: Math.round(cardBox.x), y: Math.round(cardBox.y) }, after: { x: Math.round(movedBox.x), y: Math.round(movedBox.y) } }));
    expect(Math.abs(movedBox.x - cardBox.x) + Math.abs(movedBox.y - cardBox.y), "退出批注后组件仍应能长按拖动").toBeGreaterThan(20);

    // 5) 组件上的右击应给出该组件的操作（点卡片内部，避开右上的 ⋯ 按钮）
    const insideBox = (await card.boundingBox())!;
    await page.mouse.click(insideBox.x + insideBox.width / 2, insideBox.y + 60, { button: "right" });
    const cardMenu = page.locator("[role='menu']").first();
    await expect(cardMenu, "组件上右击也应弹出菜单").toBeVisible({ timeout: 5_000 });
    const cardMenuText = await cardMenu.innerText();
    console.log("组件右击栏:", JSON.stringify(cardMenuText.replace(/\s+/g, " ").slice(0, 200)));
    for (const expected of ["置顶", "折叠", "复制一份", "移除"]) expect(cardMenuText, `组件菜单应包含「${expected}」`).toContain(expected);

    expect(errors, "不应有未捕获异常").toEqual([]);
  } finally { await f.close(); }
});

test("clicking empty canvas dismisses the right-click menu and the component palette", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const me = await f.login("canvas-dismiss@example.test", "收起验证");
    const project = await f.request<Project>("projects", "POST", {
      name: "点击收起验收空间", timezone: "Asia/Shanghai", goal: "验证点击空白处收起",
      minimumDeliverable: "可演示", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
    }, me, 201);
    const page = await f.page(me, 1440);
    await page.goto(`/app/projects/${project.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);

    const menu = page.locator("[role='menu']");
    const blank = await blankCanvasPoint(page);
    expect(blank, "应能找到画布空白点").not.toBeNull();

    // 1) 右击栏：右击打开 → 点菜单之外的空白收起。
    //    注意菜单从右击点向右下展开（宽 236、高约 500），"点空白"必须避开菜单矩形，
    //    否则点的是菜单自己，看起来像"收起失效"。
    await page.mouse.click(blank!.x, blank!.y, { button: "right" });
    const menuEl = menu.first();
    await expect(menuEl, "右击应弹出菜单").toBeVisible({ timeout: 5_000 });
    const menuBox = (await menuEl.boundingBox())!;
    const outside = await blankCanvasPoint(page, menuBox);
    expect(outside, "应能找到菜单之外的画布空白点").not.toBeNull();
    await page.mouse.click(outside!.x, outside!.y);
    await expect(menu, "点空白处应把右击栏收起来（不能一直挂在屏幕上）").toHaveCount(0);

    // 2) Esc 也能收起
    await page.mouse.click(blank!.x, blank!.y, { button: "right" });
    await expect(menu.first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu, "Esc 应能收起右击栏").toHaveCount(0);

    // 3) 组件栏：打开 → 点空白处收起
    const palette = page.locator("[class*='palette']").first();
    await palette.locator("summary").first().click();
    await expect(palette, "点「组件」应展开组件栏").toHaveAttribute("open", "");
    await page.mouse.click(outside!.x, outside!.y);
    await expect(palette, "点空白处应收起组件栏").not.toHaveAttribute("open", "");
  } finally { await f.close(); }
});

test("右击栏在小窗口里也完整可见、每一项都点得动", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const me = await f.login("canvas-viewport@example.test", "小窗验证");
    const project = await f.request<Project>("projects", "POST", {
      name: "小窗菜单验收空间", timezone: "Asia/Shanghai", goal: "验证菜单不被视口裁掉",
      minimumDeliverable: "可演示", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
    }, me, 201);
    // 用一个明显矮于菜单内容的窗口复现用户报的"点不动"：菜单高约 558，
    // 不做边界约束时底部会到 858，在 600/720 高的窗口里下半部分物理点不到。
    const page = await f.page(me, 1000);
    await page.setViewportSize({ width: 1000, height: 600 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(`/app/projects/${project.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);

    const blank = await page.evaluate(() => {
      for (let y = 300; y < window.innerHeight - 40; y += 12) for (let x = 40; x < window.innerWidth - 40; x += 12) {
        const node = document.elementFromPoint(x, y) as HTMLElement | null;
        if (node?.hasAttribute("data-mobile")) return { x, y };
      }
      return null;
    });
    expect(blank, "应能找到画布空白点").not.toBeNull();

    /** 打开菜单并返回它的矩形与视口。 */
    const openMenu = async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      await page.mouse.click(blank!.x, blank!.y, { button: "right" });
      await page.waitForTimeout(300);
      const node = page.locator("[role='menu']").first();
      await expect(node).toBeVisible({ timeout: 5_000 });
      return { box: (await node.boundingBox())!, viewport: page.viewportSize()! };
    };

    // ① 菜单必须完整落在视口内
    const { box, viewport } = await openMenu();
    console.log("菜单矩形:", JSON.stringify({ x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }), "视口:", JSON.stringify(viewport));
    expect(box.y, "菜单顶部不能为负").toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, "菜单底部必须落在视口内，否则下半部分点不到").toBeLessThanOrEqual(viewport.height + 1);
    expect(box.x + box.width, "菜单不能超出右边界").toBeLessThanOrEqual(viewport.width + 1);

    // ② 每一项都必须真的点得动（点击会关闭菜单，所以每次都重新打开）
    for (const name of ["画笔", "荧光笔", "箭头", "文字便签", "橡皮", "重置视图", "缩放回 100%"]) {
      await openMenu();
      const item = page.locator("[role='menu']").first().getByRole("menuitem", { name });
      await expect(item, `「${name}」应可用`).toBeEnabled();
      await item.click({ timeout: 4_000 });
      await page.waitForTimeout(200);
      await expect(page.locator("[role='menu']"), `点「${name}」后菜单应收起`).toHaveCount(0);
    }

    expect(errors, "不应有未捕获异常").toEqual([]);
  } finally { await f.close(); }
});

test("取消批注只取消选中的工具（保留笔迹），清空笔迹才删内容", async ({ browser }, info) => {
  const f = await isolatedWorkspace(browser, info);
  try {
    const me = await f.login("canvas-cancel@example.test", "取消验证");
    const project = await f.request<Project>("projects", "POST", {
      name: "取消批注验收空间", timezone: "Asia/Shanghai", goal: "验证取消批注与清空笔迹的区别",
      minimumDeliverable: "可演示", deadline: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
    }, me, 201);
    const page = await f.page(me, 1440);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error).slice(0, 200)));
    await page.goto(`/app/projects/${project.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);

    const blank = await blankCanvasPoint(page);
    expect(blank).not.toBeNull();

    await page.mouse.click(blank!.x, blank!.y, { button: "right" });
    await page.locator("[role='menu']").first().getByRole("menuitem", { name: "画笔" }).click();
    const bar = page.locator("[class*='annotationBar']").first();
    await expect(bar).toBeVisible();

    // 画两笔，便于区分"取消"与"清空"
    for (const offset of [0, 40]) {
      await page.mouse.move(blank!.x + 20, blank!.y + 20 + offset);
      await page.mouse.down();
      for (let step = 1; step <= 8; step += 1) await page.mouse.move(blank!.x + 20 + step * 12, blank!.y + 20 + offset + step * 3);
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    const layer = page.locator("[class*='annotationLayer']").first();
    const drawnCount = await layer.locator("polyline").count();
    console.log("画完笔迹数:", drawnCount);
    expect(drawnCount, "画笔应留下笔迹").toBeGreaterThan(0);

    // ① 取消批注＝取消选中的工具：工具条收起，但**笔迹必须保留**
    await expect(bar.getByRole("button", { name: "取消批注（取消选中的工具）" }), "工具栏应有取消批注按钮").toBeVisible();
    await bar.getByRole("button", { name: "取消批注（取消选中的工具）" }).click();
    await page.waitForTimeout(300);
    await expect(page.locator("[class*='annotationBar']"), "取消工具后工具栏应收起").toHaveCount(0);
    const kept = await page.evaluate(() => {
      const svg = document.querySelector("[class*='annotationLayer']") as SVGSVGElement | null;
      return svg ? svg.querySelectorAll("polyline").length : 0;
    });
    console.log("取消工具后笔迹数:", kept);
    expect(kept, "取消批注只是取消工具，不得删掉已经画好的笔迹").toBe(drawnCount);

    // ② 取消工具后组件能正常长按拖动（真的回到了普通操作）
    const card = page.locator("[data-instance-id]").first();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const cardBox = (await card.boundingBox())!;
    await page.mouse.move(cardBox.x + 30, cardBox.y + 8);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.move(cardBox.x + 130, cardBox.y + 80, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const moved = (await card.boundingBox())!;
    console.log("取消工具后长按拖动位移:", Math.round(Math.abs(moved.x - cardBox.x) + Math.abs(moved.y - cardBox.y)));
    expect(Math.abs(moved.x - cardBox.x) + Math.abs(moved.y - cardBox.y), "取消工具后组件应能长按拖动").toBeGreaterThan(20);

    // ③ 清空笔迹才是删内容
    await page.mouse.click(blank!.x, blank!.y, { button: "right" });
    const menu = page.locator("[role='menu']").first();
    await expect(menu).toBeVisible();
    const clear = menu.getByRole("menuitem", { name: "清空笔迹" });
    await expect(clear, "笔迹还在，清空笔迹应可用").toBeEnabled();
    await clear.click();
    await page.waitForTimeout(300);
    const cleared = await page.evaluate(() => {
      const svg = document.querySelector("[class*='annotationLayer']") as SVGSVGElement | null;
      return svg ? svg.querySelectorAll("polyline").length : 0;
    });
    console.log("清空后笔迹数:", cleared);
    expect(cleared, "清空笔迹应真的删掉内容").toBe(0);
    expect(errors, "不应有未捕获异常").toEqual([]);
  } finally { await f.close(); }
});
