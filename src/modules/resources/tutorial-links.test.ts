import assert from "node:assert/strict";
import test from "node:test";
import { readTutorialFilters, tutorialDirectoryHref, tutorialFilterQuery, tutorialLink } from "./tutorial-links.ts";

test("教程下一步允许白名单站内路径，并保留筛选和锚点", () => {
  for (const href of ["/events", "/app/projects/team_1", "/resources", "/skills/bundles/general", "/library/start-here", "/inspiration", "/participation", "/roadshow", "/ppt", "/github", "/library?category=GitHub+%E6%8C%87%E5%8D%97&query=README#steps"]) {
    assert.deepEqual(tutorialLink(href), { href, external: false });
  }
});

test("教程链接拒绝协议相对、反斜杠、控制字符和非白名单路径", () => {
  for (const href of ["//evil.example/path", "/\\evil.example", "https:\\evil.example", "https://docs.example/a\\b", "https://docs.example/%5csecret", "https://docs.example/a\nb", "/library?query=%0aevil", "/library?query=%C2%85evil", "\u0000https://docs.example", " https://docs.example", "/admin", "/api/v1/library", "/app//evil", "/library/../github", "/library/%2e%2e/github", "/library/%"] ) {
    assert.equal(tutorialLink(href), null, href);
  }
});

test("外部参考只允许明确 HTTP(S) 地址且不携带账号密码", () => {
  assert.deepEqual(tutorialLink("https://docs.github.com/en/get-started/using-github/hello-world"), { href: "https://docs.github.com/en/get-started/using-github/hello-world", external: true });
  assert.deepEqual(tutorialLink("https://example.org/search?q=%E4%B8%AD%E6%96%87"), { href: "https://example.org/search?q=%E4%B8%AD%E6%96%87", external: true });
  assert.deepEqual(tutorialLink("http://example.org"), { href: "http://example.org/", external: true });
  for (const href of ["javascript:alert(1)", "data:text/html,hello", "mailto:hello@example.org", "ftp://example.org", "https:example.org", "https:///example.org", "https://user@example.org", "https://user:secret@example.org", "docs.github.com"]) assert.equal(tutorialLink(href), null, href);
});

test("教程筛选返回链接固定到目录，转义值并只保留 API 允许的条件", () => {
  const filters = readTutorialFilters(new URLSearchParams("category=GitHub+%E6%8C%87%E5%8D%97&query=README%26category%3Dother&returnTo=https%3A%2F%2Fevil.example"));
  const href = tutorialDirectoryHref(filters);
  const parsed = new URL(href, "https://local.example");
  assert.equal(parsed.pathname, "/library");
  assert.equal(parsed.searchParams.get("category"), "GitHub 指南");
  assert.equal(parsed.searchParams.get("query"), "README&category=other");
  assert.equal(parsed.searchParams.has("returnTo"), false);
  assert.equal(tutorialDirectoryHref({ category: "", query: "" }), "/library");
  const bounded = readTutorialFilters(new URLSearchParams({ category: "A".repeat(80), query: `\n${"B".repeat(120)}\u007f` }));
  assert.equal(bounded.category.length, 60);
  assert.equal(bounded.query.length, 100);
  assert.equal(tutorialFilterQuery({ category: "  ", query: "\n  " }), "");
});
