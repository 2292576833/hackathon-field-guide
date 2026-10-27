import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { getJourneyGuide, isJourneyHref, validateJourneyGuide } from "./index.ts";
import type { JourneyGuide, JourneyNode } from "./model.ts";

function nodes(guide: JourneyGuide = getJourneyGuide()): readonly JourneyNode[] {
  return guide.phases.flatMap(phase => phase.nodes);
}

function node(id: string): JourneyNode {
  const found = nodes().find(item => item.id === id);
  assert.ok(found, `Missing journey action: ${id}`);
  return found;
}

function links(guide: JourneyGuide = getJourneyGuide()): readonly string[] {
  return [
    ...guide.root.actions.map(action => action.href),
    ...nodes(guide).flatMap(item => [item.href, ...item.resources.map(resource => resource.href)]),
  ];
}

test("公开树根连接三阶段，赛前从找比赛开始，每个行动有用途说明与入口", () => {
  const guide = getJourneyGuide();
  assert.deepEqual(validateJourneyGuide(guide), []);
  assert.deepEqual(guide.phases.map(phase => phase.id), ["before", "during", "after"]);
  assert.equal(guide.phases[0].nodes[0].id, "find-event");
  assert.equal(guide.phases[0].nodes[0].href, "/events");
  assert.ok(guide.root.actions.some(action => action.href === "/events"));
  assert.ok(guide.root.actions.some(action => action.href === "/app"));
  const ids = [guide.root.id, ...guide.phases.flatMap(phase => [phase.id, ...phase.nodes.map(item => item.id)])];
  assert.equal(new Set(ids).size, ids.length);
  for (const phase of guide.phases) assert.ok(phase.cautions.length > 0);
  for (const item of nodes(guide)) {
    assert.ok(item.actionLabel.trim());
    assert.ok(item.resources.length > 0);
    assert.ok(item.resources.every(resource => resource.description.trim().length > 0));
  }
});

test("所有栏目和教程目的地确实存在，团队操作统一先选空间", () => {
  const appRoot = resolve(import.meta.dirname, "../../app");
  const librarySource = readFileSync(resolve(import.meta.dirname, "../../server/library.ts"), "utf8");
  const articleSlugs = new Set([...librarySource.matchAll(/slug:\s*"([a-z-]+)"/g)].map(match => match[1]));
  const destinations = new Set(links());
  for (const href of destinations) {
    assert.ok(isJourneyHref(href), href);
    if (href.startsWith("/library/")) {
      assert.ok(articleSlugs.has(href.slice("/library/".length)), `Actual library article: ${href}`);
      assert.ok(existsSync(resolve(appRoot, "(site)/library/[slug]/page.tsx")));
    } else {
      const route = ["/app", "/app/account", "/competitions"].includes(href) ? href.slice(1) : `(site)${href}`;
      assert.ok(existsSync(resolve(appRoot, route, "page.tsx")), `Actual page: ${href}`);
    }
  }
  for (const href of ["/events", "/competitions", "/app", "/participation", "/app/account", "/resources", "/inspiration", "/skills", "/github", "/roadshow", "/ppt"]) {
    assert.ok(destinations.has(href), `Required journey destination: ${href}`);
  }
  for (const id of ["define-demo", "invite-and-assign", "plan-dependencies", "build-core-demo", "integrate-and-test", "save-and-submit", "review-experience", "preserve-results", "reuse-next-time"]) {
    assert.equal(node(id).href, "/app", `Select a real space before ${id}`);
  }
});

test("链接白名单拒绝外站、执行接口、虚假空间、查询参数和路径变体", () => {
  for (const href of [
    "https://example.org", "//example.org", "javascript:alert(1)", "/api/v1/projects",
    "/admin", "/app/projects/projectId/plan", "/app/projects/example/delivery",
    "/library/not-an-article", "/library/../events", "/library/%2e%2e/events",
    "/events?projectId=example", "/app#fake-progress", "/app/", " /events", "/\\events", "/events\n",
  ]) assert.equal(isJourneyHref(href), false, href);
  const guide = getJourneyGuide();
  Reflect.set(guide.phases[0].nodes[0], "href", "/api/v1/projects");
  assert.ok(validateJourneyGuide(guide).some(error => error.includes("unsupported destination")));
});

test("内容校验发现重复 ID、断开的阶段、缺少注意事项或资源用途", () => {
  const duplicate = getJourneyGuide();
  Reflect.set(duplicate.phases[0].nodes[0], "id", duplicate.root.id);
  assert.ok(validateJourneyGuide(duplicate).some(error => error.includes("duplicate id")));
  const reordered = getJourneyGuide();
  Reflect.set(reordered, "phases", [...reordered.phases].reverse());
  assert.ok(validateJourneyGuide(reordered).some(error => error.includes("preparation order")));
  const noCautions = getJourneyGuide();
  Reflect.set(noCautions.phases[1], "cautions", []);
  assert.ok(validateJourneyGuide(noCautions).some(error => error.includes("phase cautions")));
  const noPurpose = getJourneyGuide();
  Reflect.set(noPurpose.phases[0].nodes[0].resources[0], "description", " ");
  assert.ok(validateJourneyGuide(noPurpose).some(error => error.includes("text is required")));
});

test("指南不接受账号、私人资料、进度或完成状态，读取互不污染", () => {
  const altered = getJourneyGuide();
  Reflect.set(altered, "accountId", "private-account");
  Reflect.set(altered.root, "projectId", "private-project");
  Reflect.set(altered.phases[0], "progress", 100);
  Reflect.set(altered.phases[0].nodes[0], "checked", true);
  Reflect.set(altered.phases[0].nodes[0].resources[0], "status", "installed");
  const errors = validateJourneyGuide(altered);
  for (const field of ["accountId", "projectId", "progress", "checked", "status"]) {
    assert.ok(errors.some(error => error.includes(`.${field}: unexpected field`)), field);
  }
  Reflect.set(altered.root, "title", "changed by consumer");
  Reflect.set(altered.phases[0].nodes[0].resources[0], "href", "/private");
  const fresh = getJourneyGuide();
  assert.deepEqual(validateJourneyGuide(fresh), []);
  assert.notEqual(fresh.root.title, altered.root.title);
  assert.notEqual(fresh.phases[0].nodes[0].resources[0].href, altered.phases[0].nodes[0].resources[0].href);
  assert.notStrictEqual(fresh.root, altered.root);
});

test("准备顺序保留可并行工作，最终视频明确依赖可演示成果", () => {
  assert.match(node("design-ui-assets").parallel ?? "", /可提前并行/);
  assert.match(node("prepare-pitch").parallel ?? "", /可提前并行/);
  assert.match(node("plan-dependencies").parallel ?? "", /不是强制依赖/);
  assert.match(node("record-demo-video").parallel ?? "", /最终视频依赖可演示流程/);
  assert.match(node("record-demo-video").description, /是否要求视频/);
  const guide = getJourneyGuide();
  assert.match(guide.root.description, /主办方.*优先/);
  assert.match(guide.root.description, /点击不代表完成/);
});

test("来源与交付语义保留未核验、可选分工及保存运行提交的区别", () => {
  const guide = getJourneyGuide();
  assert.match(guide.phases[0].cautions.join(" "), /未核验线索/);
  assert.match(node("invite-and-assign").description, /自选.*AI.*管理员确认/);
  const inspiration = node("design-ui-assets").resources.find(resource => resource.href === "/inspiration")!;
  assert.match(inspiration.description, /未经人工核验/);
  assert.match(inspiration.description, /未分析.*等待状态/);
  assert.match(guide.phases[1].cautions.join(" "), /参考不等于.*许可/);
  assert.match(guide.phases[1].cautions.join(" "), /代码保存、实际运行检查.*正式提交分开记录/);
  assert.match(node("save-and-submit").description, /主办方.*正式提交入口.*回执/);
  assert.match(node("review-experience").description, /实际任务和交付记录/);
  assert.match(guide.phases[2].cautions.join(" "), /复盘不生成另一份/);
});
