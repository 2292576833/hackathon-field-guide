import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project, ProjectMember } from "../modules/projects/model.ts";
import { planningProjectFactsVersion } from "./planning-project-facts.ts";

const project: Project = { id: "project-1", name: "新人参赛", teamId: null, eventId: null, createdBy: "owner",
  goal: "把核心流程做成", minimumDeliverable: "能操作的 Demo", stage: "preparing", timezone: "Asia/Shanghai",
  deadline: "2026-10-12T00:00:00.000Z", deadlineSource: "member_entered", revision: 4,
  createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" };
const members: ProjectMember[] = [{ membershipId: "m-owner", projectId: project.id, userId: "owner", role: "manager", status: "active", revision: 1, joinedAt: project.createdAt, leftAt: null },
  { membershipId: "m-peer", projectId: project.id, userId: "peer", role: "member", status: "active", revision: 1, joinedAt: project.createdAt, leftAt: null }];

test("starting execution or changing display metadata keeps the plan's project basis", () => {
  assert.equal(planningProjectFactsVersion(project, members), planningProjectFactsVersion({ ...project, stage: "active", revision: 5, updatedAt: "2026-10-09T01:00:00.000Z" }, [...members].reverse()));
});

test("project goal, scope, time and association updates still change the protected plan basis", () => {
  for (const changes of [{ goal: "另一个目标" }, { minimumDeliverable: "增加必须成果" }, { timezone: "UTC" },
    { deadline: "2026-10-12T01:00:00.000Z" }, { deadlineSource: "unknown" as const }, { teamId: "another-team" }, { eventId: "another-event" }, { name: "新的空间名" }]) {
    assert.notEqual(planningProjectFactsVersion(project, members), planningProjectFactsVersion({ ...project, ...changes }, members));
  }
});

test("joining, leaving, changing user identity, role or membership revision changes the protected basis", () => {
  const original = planningProjectFactsVersion(project, members);
  for (const changes of [{ role: "manager" as const }, { revision: 2 }, { status: "left" as const }, { userId: "another-peer" }]) {
    assert.notEqual(original, planningProjectFactsVersion(project, [members[0]!, { ...members[1]!, ...changes }]));
  }
  assert.notEqual(original, planningProjectFactsVersion(project, [members[0]!]));
  assert.notEqual(original, planningProjectFactsVersion(project, [...members, { ...members[1]!, membershipId: "m-new", userId: "new-peer" }]));
});
