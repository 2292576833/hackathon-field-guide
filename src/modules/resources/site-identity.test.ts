import assert from "node:assert/strict";
import test from "node:test";
import { resourceSiteIdentity } from "./site-identity.ts";

test("同站文档链接对应固定官网身份，但不改变审核内容或产品范围", () => {
  assert.equal(resourceSiteIdentity("https://ui.shadcn.com/docs")?.url, "https://ui.shadcn.com/");
  assert.equal(resourceSiteIdentity("https://ant.design/components/overview/")?.id, "ant-design");
  const radix = resourceSiteIdentity("https://www.radix-ui.com/primitives/docs/overview/introduction");
  assert.equal(radix?.name, "Radix UI");
  assert.equal(radix?.inspirationHref, "/inspiration?q=Radix+UI");
  assert.equal(resourceSiteIdentity("https://www.awwwards.com/")?.inspirationHref, "/inspiration?q=Awwwards");
});

test("伪造域、未知站点或不安全链接不获得同站身份", () => {
  for (const url of ["https://awwwards.com.evil.invalid/", "https://unknown.invalid/", "https://constructor/", "https://__proto__/", "javascript:alert(1)", "//awwwards.com", "https://user@awwwards.com/", "https://www.awwwards.com/\\evil", "https://www.awwwards.com/\n"]) assert.equal(resourceSiteIdentity(url), null);
});
