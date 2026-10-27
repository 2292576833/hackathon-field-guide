/**
 * home-next · 首页"下一步"逻辑（规划27 第 2 期 2.1）。
 *
 * 纯函数模块：只由登录态与本人只读事实推出"我现在该干吗"。
 * 不读库、不发请求、不写状态、不产生完成百分比。
 * 首页装配（`src/app/page.tsx`）由主会话负责，见 `docs/协作/交付/home-next.md`。
 */
export type { HomeNextInput, HomeProjectFacts, NextStep, NextStepKind } from "./model.ts";
export { isNextStepKind } from "./model.ts";
export { buildHomeNextStep, buildResultsNextStep, buildUnreadNextStep } from "./next-step.ts";
