import assert from "node:assert/strict";
import test from "node:test";
import { safeAuthReturnTo } from "./index.ts";

test("login returns to the mounted account/team/library/skill destinations", () => {
  for (const path of [
    "/app/account", "/app/teams", "/app/teams/team-1", "/library", "/library/ui-components",
    "/skills", "/skills/skill-1", "/app/projects/project-1", "/app/projects/project-1/delivery",
    "/admin", `/app/join/${"a".repeat(43)}`,
  ]) assert.equal(safeAuthReturnTo(path), path);
});

test("new return routes cannot introduce encoded, cross-origin or path traversal redirects", () => {
  for (const path of [
    "//evil.example/library", "https://evil.example/app/account", "/library/%2f%2fevil.example",
    "/library/%252f%252fevil.example", "/%2561pp/account", "/app/teams/../../account",
    "/app/teams/..", "/skills/skill-1/extra", "/app/account?next=//evil.example",
    "/app/account#//evil.example", "/app\\account", "/app/account\n", "/library//evil.example",
  ]) assert.equal(safeAuthReturnTo(path), "/app");
});

test("login preserves resource filters and pagination on both catalog and detail pages", () => {
  const parameters = new URLSearchParams({
    search: "表单 & 图标", type: "ui_visual", stage: "development", stack: "react",
    prerequisite: "basic_code", use: "form", costType: "unknown", sort: "verified", limit: "30", cursor: "60",
  });
  for (const path of ["/resources", "/resources/resource-1"]) {
    const destination = `${path}?${parameters}`;
    assert.equal(safeAuthReturnTo(destination), destination);
  }
  for (const [name, values] of Object.entries({
    type: ["inspiration", "ai_design", "ui_visual", "practical_tool"],
    stage: ["preparation", "design", "development", "delivery", "retrospective"],
    stack: ["stack_agnostic", "html_css", "react", "vue", "unknown"],
    prerequisite: ["browse", "account", "basic_code", "environment"],
    use: ["layout", "workspace", "form", "flowchart", "icons", "prototype", "collaboration", "development", "deployment", "presentation", "review"],
    costType: ["free_plan", "free_and_paid", "usage_based", "self_hosted", "unknown"],
    sort: ["editorial", "name", "verified"], limit: ["1", "50"], cursor: ["0", "1000000"],
  })) {
    for (const value of values) {
      const destination = `/resources?${new URLSearchParams({ [name]: value })}`;
      assert.equal(safeAuthReturnTo(destination), destination, `${name}=${value}`);
    }
  }
  const search = `/resources?${new URLSearchParams({ search: "x".repeat(200) })}`;
  assert.equal(safeAuthReturnTo(search), search);
  // Search text is data inside a fixed resource route, never a redirect destination.
  const literalSearch = `/resources?${new URLSearchParams({ search: "C:\\repo //example.invalid/?next=other" })}`;
  assert.equal(safeAuthReturnTo(literalSearch), literalSearch);
});

test("resource return filters reject unsupported, duplicate and malformed context", () => {
  for (const suffix of [
    "search=", `search=${"x".repeat(201)}`, "search=%0a", "search=%00", "search=%7f", "search=%", "search=%2G",
    "type=skill", "stage=other", "stack=other", "prerequisite=other", "use=other", "costType=other", "sort=other",
    "limit=0", "limit=51", "limit=100", "limit=-1", "limit=2.5", "cursor=-1", "cursor=1000001", "cursor=00000000",
    "stack=react&stack=vue", "stack=react&%73tack=vue", "cursor=1&cursor=2", "search=ok&search=again",
    "next=https%3A%2F%2Fevil.example", "search=ok&returnTo=%2Fadmin", "search=ok&userId=other",
    "stack=%2572eact", "stack=react?next=other", "search=ok#fragment",
  ]) {
    for (const path of ["/resources", "/resources/resource-1"]) {
      assert.equal(safeAuthReturnTo(`${path}?${suffix}`), "/app", `${path}?${suffix}`);
    }
  }
  for (const destination of [
    "//evil.example/resources?stack=react", "https://evil.example/resources?stack=react",
    "/resources/%2F%2Fevil.example?stack=react", "/resources/%252Fadmin?stack=react",
    "/resources/../account?stack=react", "/resources\\other?stack=react",
  ]) assert.equal(safeAuthReturnTo(destination), "/app", destination);
});

test("login retains the selected event, discovery and GitHub project context", () => {
  for (const destination of [
    "/app?event=event-1", `/app?event=${"a".repeat(128)}`,
    "/app/account?event=event-1",
    "/app/projects/project-1/rules?discovery=discovery_1",
    `/app/projects/${"p".repeat(128)}/rules?discovery=${"d".repeat(128)}`,
    "/github?projectId=project-1", `/github?projectId=${"p".repeat(128)}`,
  ]) assert.equal(safeAuthReturnTo(destination), destination);
});

test("event, discovery and GitHub return routes reject arbitrary parameters and encoded bypasses", () => {
  for (const destination of [
    "/app?event=", `/app?event=${"a".repeat(129)}`, "/app?event=one&event=two",
    "/app/account?event=one&event=two", "/app/account?event=%2Fadmin", "/app/account?event=one&next=/admin",
    "/app?event=event%2D1", "/app?event=%2F%2Fevil.example", "/app?event=%252Fadmin",
    "/app?event=one&next=%2Fadmin", "/app?next=event-1", "/app?event=one#fragment",
    "/app/projects/project-1/rules?discovery=", "/app/projects/project-1/rules?discovery=one&discovery=two",
    "/app/projects/project-1/rules?discovery=one&next=%2Fadmin",
    "/app/projects/project-1/rules?discovery=discovery%2D1", "/app/projects/project-1/rules?discovery=%252Fadmin",
    "/app/projects/%70roject-1/rules?discovery=one", "/app/projects/project-1/plan?discovery=one",
    `/app/projects/${"p".repeat(129)}/rules?discovery=one`, `/app/projects/project-1/rules?discovery=${"d".repeat(129)}`,
    "/github?projectId=", `/github?projectId=${"p".repeat(129)}`, "/github?projectId=one&projectId=two",
    "/github?projectId=one&%70rojectId=two", "/github?projectId=one&next=https%3A%2F%2Fevil.example",
    "/github?projectId=%2Fadmin", "/github?projectId=%252Fadmin", "/github?projectId=one%00",
    "//evil.example/github?projectId=one", "https://evil.example/app?event=one",
  ]) assert.equal(safeAuthReturnTo(destination), "/app", destination);
});
