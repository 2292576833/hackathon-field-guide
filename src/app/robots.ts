import type { MetadataRoute } from "next";

/**
 * 规划35 §2：主办方的专属页 `/s/<短码>` 是**分发链接**，默认不进搜索引擎；
 * 其余公开页面（/competitions、/events、/journey、/resources 等）保持可索引。
 * 页面级还会用 `robots: { index: false }` 再确认一次，不只依赖这里。
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/s/"] }],
  };
}
