import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResourceQuery } from "./domain.ts";
import { readResourceLocation, resourceCatalogHref, resourceDetailHref, resourceLocationParams } from "./navigation.ts";

test("资源详情和返回目录保留所有有效筛选及分页位置", () => {
  const query = { search: "表单 & 图标", type: "ui_visual", stage: "development", stack: "react", prerequisite: "basic_code", use: "form", costType: "unknown", sort: "verified", limit: 30 } as const;
  const detail = new URL(resourceDetailHref("resource/id", query, "60"), "https://site.invalid");
  assert.equal(detail.pathname, "/resources/resource%2Fid");
  const context = readResourceLocation(detail.searchParams);
  assert.deepEqual(context, { query, cursor: "60" });
  const catalog = new URL(resourceCatalogHref(context.query, context.cursor), "https://site.invalid");
  assert.equal(catalog.pathname, "/resources");
  assert.equal(catalog.search, detail.search);
  assert.equal(normalizeResourceQuery({ ...context.query, cursor: context.cursor }).offset, 60);
});

test("目录上下文丢弃未知字段和无效值，不能把返回路径或身份传给公开API", () => {
  const params = new URLSearchParams({ search: "ok", type: "skill", stack: "other", limit: "100", cursor: "-1", returnTo: "//evil.invalid", userId: "other-user" });
  assert.deepEqual(readResourceLocation(params), { query: { search: "ok" }, cursor: "" });
  assert.equal(resourceLocationParams(Object.fromEntries(params) as never, "1000001").toString(), "search=ok");
  assert.equal(resourceCatalogHref(), "/resources");
});

test("过长或含控制字符关键词不会生成无效资源请求，正常中文仍保留", () => {
  for (const search of ["x".repeat(201), "a\nb", "a\u0000b", "a\u007fb"]) assert.deepEqual(readResourceLocation(new URLSearchParams({ search })).query, {});
  assert.equal(readResourceLocation(new URLSearchParams({ search: "准备演示" })).query.search, "准备演示");
  for (const cursor of ["abc", "2.5", "1000001", "00000000"]) assert.equal(readResourceLocation(new URLSearchParams({ cursor })).cursor, "");
});
