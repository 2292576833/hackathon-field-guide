// 入口保持 Node 可直接执行：只导出纯函数与类型，不加载 React、不触达服务端与数据库。
export { adviseScopeCut } from "./advice.ts";
export { SCOPE_CUT_UNKNOWN_NOTICE_PREFIX, SCOPE_CUT_WINDOWS } from "./model.ts";
export type {
  ScopeCutAdvice,
  ScopeCutFacts,
  ScopeCutTaskCounts,
  ScopeCutVerdict,
} from "./model.ts";
