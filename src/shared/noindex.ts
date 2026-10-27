/**
 * 规划35 §2：专属页 `/s/<短码>` 默认不进搜索引擎。
 * 与 `src/app/robots.ts` 的 disallow 是**双保险**：robots 挡爬虫，这里挡页面级索引。
 * 只用于专属页；平台公开页（赛事页、目录、路线图等）不得使用。
 */
export const NOINDEX_METADATA = Object.freeze({
  robots: Object.freeze({ index: false, follow: false, nocache: true }),
});
