import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor, ProjectMembershipAccess } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { PostgresAssessmentTransaction } from "./postgres.ts";
import { MemoryAssessmentRepository } from "./testing/memory-repository.ts";
import { AssessmentService } from "./service.ts";
import { FixedQuestionCatalog, PILOT_QUESTION_SET, PILOT_RUBRIC } from "./catalog.ts";
import type { AssignmentContextSnapshot } from "./types.ts";

test("real SQL reference projection selects only consented metadata across both sharing selections", async () => {
  const database = new PGlite(); await database.waitReady;
  try {
    await database.exec("CREATE TABLE assessments_attempts(id text PRIMARY KEY,project_id text,user_id text,membership_id text,revision integer,data jsonb)");
    for (const [id, projectId, sharing] of [
      ["private", "p", { confirmedTasks: [], criterionIds: [] }],
      ["task", "p", { confirmedTasks: ["testing"], criterionIds: [] }],
      ["criterion", "p", { confirmedTasks: [], criterionIds: ["criterion-id"] }],
      ["foreign", "other", { confirmedTasks: ["testing"], criterionIds: [] }],
    ] as const) await database.query("INSERT INTO assessments_attempts VALUES($1,$2,$3,$4,$5,$6::jsonb)", [id, projectId, "author", "member", 3, JSON.stringify({ sharing, answers: [{ text: "PRIVATE_ANSWER_SENTINEL" }], profile: { experience: "PRIVATE_PROFILE" } })]);
    const statements: string[] = [];
    const sql: SqlExecutor = { async query<Row>(statement: string, parameters: readonly unknown[] = []) { statements.push(statement); const result = await database.query<Row>(statement, [...parameters]); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; } };
    const refs = await new PostgresAssessmentTransaction(sql).listSharedSummaryRefs("p");
    assert.deepEqual(refs.map(ref => ref.attemptId), ["criterion", "task"]);
    assert.ok(refs.every(ref => Object.keys(ref).sort().join(",") === "attemptId,membershipId,revision,userId"));
    assert.ok(statements.every(statement => /^\s*SELECT id,user_id,membership_id,revision FROM/.test(statement)));
    assert.ok(!JSON.stringify(refs).includes("PRIVATE_"));
    await database.query("UPDATE assessments_attempts SET data=jsonb_set(data,'{sharing}',$1::jsonb),revision=4 WHERE id='task'", [JSON.stringify({ confirmedTasks: [], criterionIds: [] })]);
    assert.deepEqual((await new PostgresAssessmentTransaction(sql).listSharedSummaryRefs("p")).map(ref => ref.attemptId), ["criterion"]);
  } finally { await database.close(); }
});

test("assignment read views never request private attempts or scores, while sharing changes remain stale", async () => {
  const repository = new MemoryAssessmentRepository(); let viewOnly = false; let sequence = 0;
  const manager: Actor = { userId: "manager", platformRoles: ["user"] }, alice: Actor = { userId: "alice", platformRoles: ["user"] }, bob: Actor = { userId: "bob", platformRoles: ["user"] };
  const memberships: ProjectMembershipAccess[] = [manager, alice, bob].map(actor => ({ membershipId: "member-" + actor.userId, projectId: "p", userId: actor.userId, role: actor === manager ? "manager" : "member", status: "active" }));
  let context: AssignmentContextSnapshot = { projectId: "p", projectRevision: 1, membershipRevision: 1, requirementVersionId: null, members: memberships.map(member => ({ ...member, memberAvailabilityVersionId: null })) };
  const questionSet = { ...structuredClone(PILOT_QUESTION_SET), id: "published-test-only", status: "published" as const };
  const service = new AssessmentService({ repository: { transaction: work => repository.transaction(tx => work({ ...tx,
    listAttempts: projectId => { assert.equal(viewOnly, false, "read view cannot load raw project attempts"); return tx.listAttempts(projectId); },
    getScores: attemptId => { assert.equal(viewOnly, false, "read view needs revisions, not score reasons"); return tx.getScores(attemptId); },
  })) }, catalog: new FixedQuestionCatalog({ questionSets: [questionSet], rubrics: [PILOT_RUBRIC] }), projectAccess: { getMembership: async (projectId, userId) => { const member = projectId === context.projectId ? context.members.find(member => member.userId === userId) : undefined; return member ? { ...member, projectId } : null; } }, assignmentContext: { getSnapshot: async () => structuredClone(context) }, clock: { now: () => new Date("2026-10-08T01:00:00Z") }, ids: { next: () => "read-test-" + ++sequence } });
  let a = await service.createAttempt(alice, "p", questionSet.id);
  a = await service.setSharing(alice, a.id, a.revision, { confirmedTasks: ["testing"], criterionIds: [] });
  let b = await service.createAttempt(bob, "p", questionSet.id);
  b = await service.setSharing(bob, b.id, b.revision, { confirmedTasks: [], criterionIds: [PILOT_RUBRIC.criteria[0]!.id] });
  await service.createAttempt(alice, "p", questionSet.id); // Unshared attempts add no reference.
  let assignment = await service.createAssignment(manager, "p", null, { assignments: [{ clientTaskId: "work", title: "可验收任务", priority: "must", ownerMembershipId: memberships[0]!.membershipId, helperMembershipIds: [], deliverable: "实际成果", acceptanceCriteria: ["可运行"], dependencyTaskIds: [], proposedDeadlineRef: null, reason: "本人确认", evidenceLevel: "self_reported" }], gaps: [], assumptions: [] });
  assignment = await service.validateAssignment(manager, assignment.id, assignment.revision);
  assignment = await service.applyAssignment(manager, assignment.id, assignment.revision);
  viewOnly = true;
  assert.equal((await service.getAssignment(manager, assignment.id)).inputFreshness, "current");
  assert.equal((await service.getAppliedAssignment(manager, "p")).version?.inputFreshness, "current");
  a = await service.setSharing(alice, a.id, a.revision, { confirmedTasks: [], criterionIds: [] });
  assert.equal((await service.getAssignment(manager, assignment.id)).inputFreshness, "changed");
  // Restore the selected tasks under a new revision: version alone must invalidate old references.
  await service.setSharing(alice, a.id, a.revision, { confirmedTasks: ["testing"], criterionIds: [] });
  assert.equal((await service.getAssignment(manager, assignment.id)).inputFreshness, "changed");
  context = { ...context, members: context.members.map(member => member.userId === bob.userId ? { ...member, status: "left" } : member) };
  assert.equal((await service.getAppliedAssignment(manager, "p")).version?.inputFreshness, "changed");
});
