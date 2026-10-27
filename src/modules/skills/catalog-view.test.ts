import assert from "node:assert/strict";
import test from "node:test";
import type { Skill } from "./domain.ts";
import { filterPublishedSkills, readSkillContext, skillContextQuery } from "./catalog-view.ts";
import { INITIAL_SKILLS } from "./seed.ts";

test("directory context survives detail return with bounded, encoded tool and task filters", () => {
  const context = readSkillContext(new URLSearchParams({ agentId: "cursor", track: "game", category: "design", search: "  页面 & 登录?  ", versionId: "not-a-directory-filter" }));
  const query = skillContextQuery(context);
  assert.deepEqual(readSkillContext(new URLSearchParams(query)), context);
  assert.equal(new URLSearchParams(query).get("search"), "页面 & 登录?");
  assert.equal(new URLSearchParams(query).has("versionId"), false);
  const invalid = readSkillContext(new URLSearchParams({ agentId: "unknown", track: "official-track", category: "new-task\u0000", search: "a".repeat(250) }));
  assert.equal(invalid.agentId, ""); assert.equal(invalid.track, ""); assert.equal(invalid.category, "new-task"); assert.equal(invalid.search.length, 200);
});

test("tool filtering keeps only published declared versions without claiming live compatibility", () => {
  const original = INITIAL_SKILLS.find(skill => skill.id === "frontend-design")!;
  const first = original.versions[0];
  const skill: Skill = { ...original, versions: [
    { ...first, id: "cursor-only", compatibility: first.compatibility.filter(value => value.agentId === "cursor") },
    { ...first, id: "codex-only", compatibility: first.compatibility.filter(value => value.agentId === "codex") },
    { ...first, id: "withdrawn", status: "withdrawn" },
  ] };
  const cursor = filterPublishedSkills([skill], { agentId: "cursor", category: "design", track: "game", search: "  前端  " });
  assert.deepEqual(cursor[0].versions.map(version => version.id), ["cursor-only"]);
  assert.equal(cursor[0].versions[0].compatibility[0].taskEvaluation, "not_tested");
  assert.equal(cursor[0].versions[0].compatibility[0].agentVersion, null);
  assert.equal(filterPublishedSkills([skill], { agentId: "cline" }).length, 0);
  assert.equal(filterPublishedSkills([skill], { category: "testing" }).length, 0);
  assert.equal(skill.versions.length, 3);
  assert.deepEqual(filterPublishedSkills([skill], {}).flatMap(value => value.versions.map(version => version.id)), ["cursor-only", "codex-only"]);
});
