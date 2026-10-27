import test from "node:test";
import assert from "node:assert/strict";
import type { DatabasePort } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import { createAssessmentHttpHandlers } from "../modules/assessments/index.ts";
import { createDatabase } from "./database.ts";
import { AI_SCHEMA_SQL, PostgresAiLedger, createAiWorker, type AiModuleHandler } from "./ai-jobs.ts";
import { attachAiExecutionStatus, type AiExecutionKind } from "./ai-job-status.ts";

async function fixture() {
  const database = await createDatabase({});
  for (const statement of AI_SCHEMA_SQL.split(";").filter(item => item.trim())) await database.query(statement);
  let queries = 0;
  const tracked: DatabasePort = {
    query: async (statement, parameters) => { queries++; return database.query(statement, parameters); },
    transaction: work => database.transaction(work),
  };
  return { database, tracked, queryCount: () => queries };
}
const at = "2026-10-08T12:00:00.000Z";
async function seed(database: DatabasePort, input: { id: string; revision: number; kind?: AiExecutionKind; moduleId?: string; status?: string; errorCode?: string | null; updatedAt?: string }) {
  const status = input.status ?? "failed", running = status === "running";
  await database.query(`INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,lease_owner,lease_token,lease_until,error_code,created_at,updated_at)
    VALUES($1,$2,$3,$4,'PRIVATE_CENTRAL_PROJECT','PRIVATE_CENTRAL_ACTOR',$5,$6,$7,$8::timestamptz,$9,$10::timestamptz,$11::timestamptz)`,
  [input.id, input.kind ?? "m04_scoring", input.moduleId ?? "job", input.revision, status, running ? "PRIVATE_WORKER" : null, running ? "PRIVATE_LEASE" : null, running ? "2026-10-09T12:00:00.000Z" : null, input.errorCode ?? null, at, input.updatedAt ?? at]);
}
function jobResponse(status = "queued", revision = 1, id = "job") {
  return Response.json({ data: { id, revision, status, label: "评分任务" }, requestId: "authorized-request" }, { headers: { "Cache-Control": "private, no-store", "X-Fixture": "preserve", "ETag": '"old-body"', "Content-Length": "1" } });
}

test("actual module authorization errors never cause a coordinator query even if the ID exists", async () => {
  const f = await fixture();
  try {
    await seed(f.database, { id: "private", revision: 1, errorCode: "AI_ACTOR_UNAVAILABLE" });
    const forbidden = createAssessmentHttpHandlers({
      resolveActor: async () => ({ userId: "foreign-user", platformRoles: ["user"] }), requestIds: { next: () => "forbidden-request" },
      service: { getJob: async () => { throw new DomainError("FORBIDDEN", "没有查看此任务的权限。", { status: 403 }); } } as unknown as Parameters<typeof createAssessmentHttpHandlers>[0]["service"],
    });
    const denied = await forbidden.job(new Request("https://example.com/api/v1/assessment-scoring-jobs/job"), { jobId: "job" });
    assert.equal(denied.status, 403);
    assert.strictEqual(await attachAiExecutionStatus(f.tracked, "m04_scoring", denied), denied);
    const anonymous = createAssessmentHttpHandlers({ resolveActor: async () => null, requestIds: { next: () => "anonymous-request" }, service: {} as Parameters<typeof createAssessmentHttpHandlers>[0]["service"] });
    const unauthenticated = await anonymous.job(new Request("https://example.com/api/v1/assessment-scoring-jobs/job"), { jobId: "job" });
    assert.equal(unauthenticated.status, 401);
    assert.strictEqual(await attachAiExecutionStatus(f.tracked, "m04_scoring", unauthenticated), unauthenticated);
    assert.equal(f.queryCount(), 0);
    assert.doesNotMatch(JSON.stringify(await denied.json()), /execution|PRIVATE_CENTRAL/);
  } finally { await f.database.close(); }
});

test("a real pre-dispatch coordinator rejection is visible without changing the still-queued domain job", async () => {
  const f = await fixture();
  try {
    let executions = 0;
    const handler: AiModuleHandler = {
      kind: "m04_scoring", listQueued: async () => [{ id: "job", projectId: "project", actorId: "revoked-actor", revision: 1, createdAt: at, status: "queued" }],
      execute: async () => { executions++; return { status: "succeeded" }; }, recover: async () => ({ status: "queued" }),
    };
    const worker = createAiWorker({ database: f.database, ledger: new PostgresAiLedger(f.database, { dailyProjectCallLimit: 10 }), handlers: [handler], clock: () => new Date(at), assertActor: async () => { throw new Error("PRIVATE_REVOKED_ACCOUNT_REASON"); } });
    assert.equal((await worker.runOnce()).status, "failed"); assert.equal(executions, 0);
    const response = await attachAiExecutionStatus(f.tracked, "m04_scoring", jobResponse());
    assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "private, no-store"); assert.equal(response.headers.get("X-Fixture"), "preserve");
    assert.equal(response.headers.get("Content-Length"), null); assert.equal(response.headers.get("ETag"), null);
    const body = await response.json();
    assert.equal(body.requestId, "authorized-request"); assert.equal(body.data.status, "queued"); assert.equal(body.data.label, "评分任务");
    assert.deepEqual(body.data.execution, { status: "failed", errorCode: "AI_ACTOR_UNAVAILABLE", sourceRevision: 1, updatedAt: at });
    assert.doesNotMatch(JSON.stringify(body), /revoked-actor|PRIVATE_REVOKED_ACCOUNT_REASON/);
    assert.equal((await f.database.query("SELECT id FROM ai_usage_attempts")).rows.length, 0);
  } finally { await f.database.close(); }
});

test("a newly requeued revision never inherits an older failed execution or a future execution", async () => {
  const f = await fixture();
  try {
    await seed(f.database, { id: "old", revision: 1, errorCode: "AI_ACTOR_UNAVAILABLE", updatedAt: "2026-10-08T14:00:00.000Z" });
    await seed(f.database, { id: "future", revision: 5, status: "cancelled" });
    const requeued = jobResponse("queued", 3);
    assert.strictEqual(await attachAiExecutionStatus(f.tracked, "m04_scoring", requeued), requeued);
    assert.equal((await requeued.json()).data.execution, undefined);
    await seed(f.database, { id: "current", revision: 3, status: "running" });
    const current = await attachAiExecutionStatus(f.tracked, "m04_scoring", jobResponse("queued", 3));
    const body = await current.json();
    assert.equal(body.data.status, "queued"); assert.equal(body.data.execution.status, "running"); assert.equal(body.data.execution.sourceRevision, 3);
  } finally { await f.database.close(); }
});

test("running or finished domains select the newest applicable source revision and preserve real unknown state", async () => {
  const f = await fixture();
  try {
    await seed(f.database, { id: "old", revision: 1, errorCode: "AI_ACTOR_UNAVAILABLE", updatedAt: "2026-10-08T14:00:00.000Z" });
    await seed(f.database, { id: "applicable", revision: 3, status: "unknown", errorCode: "AI_PROVIDER_UNCERTAIN" });
    await seed(f.database, { id: "future", revision: 5, status: "succeeded" });
    await seed(f.database, { id: "wrong-kind", revision: 4, kind: "m05_planning", status: "cancelled" });
    await seed(f.database, { id: "wrong-job", revision: 4, moduleId: "different-private-job", status: "failed" });
    for (const status of ["running", "failed", "succeeded", "cancelled"]) {
      const result = await attachAiExecutionStatus(f.tracked, "m04_scoring", jobResponse(status, 4));
      const body = await result.json();
      assert.equal(body.data.status, status);
      assert.deepEqual(body.data.execution, { status: "unknown", errorCode: "AI_PROVIDER_UNCERTAIN", sourceRevision: 3, updatedAt: at });
    }
  } finally { await f.database.close(); }
});

test("the central projection exposes exactly four metadata fields and supports all six job kinds", async () => {
  const f = await fixture();
  try {
    const kinds: readonly AiExecutionKind[] = ["m03_analysis", "m04_scoring", "m04_role_help", "assignment_suggestion", "m05_planning", "m07_retrospective"];
    await f.database.query("INSERT INTO ai_budget_buckets(project_id,period,calls,reserved_micro_usd,charged_micro_usd) VALUES('PRIVATE_CENTRAL_PROJECT','2026-10-08',7,91000,32000)");
    for (const [index, kind] of kinds.entries()) {
      await seed(f.database, { id: `kind-${index}`, revision: 1, kind, status: "running" });
      const response = await attachAiExecutionStatus(f.tracked, kind, jobResponse());
      const body = await response.json();
      assert.deepEqual(Object.keys(body.data.execution).sort(), ["errorCode", "sourceRevision", "status", "updatedAt"]);
      assert.equal(body.data.execution.status, "running"); assert.equal(body.data.execution.errorCode, null);
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|actorId|projectId|leaseToken|leaseOwner|budget|charged|inputTokens|outputTokens|91000|32000/);
    }
  } finally { await f.database.close(); }
});

test("lists, error envelopes, malformed JSON and invalid identity/revision responses are returned without queries", async () => {
  const f = await fixture();
  try {
    const responses = [
      Response.json({ data: [{ id: "job", revision: 1, status: "queued" }] }),
      Response.json({ data: { items: [{ id: "job", revision: 1 }] } }),
      Response.json({ error: { code: "FORBIDDEN" }, data: { id: "job", revision: 1 } }),
      new Response("not-json", { headers: { "Content-Type": "application/json" } }),
      new Response(null, { status: 204 }),
      new Response('{"data":{"id":"job","revision":1}}', { headers: { "Content-Type": "text/plain" } }),
      ...[0, -1, 1.5, "1", null, 2_147_483_648].map(revision => Response.json({ data: { id: "job", revision } })),
      ...["", " ", "job\n", "x".repeat(201), null].map(id => Response.json({ data: { id, revision: 1 } })),
      ...[400, 403, 404, 500].map(status => Response.json({ data: { id: "job", revision: 1 } }, { status })),
    ];
    for (const response of responses) assert.strictEqual(await attachAiExecutionStatus(f.tracked, "m04_scoring", response), response);
    const consumed = jobResponse(); await consumed.json();
    assert.strictEqual(await attachAiExecutionStatus(f.tracked, "m04_scoring", consumed), consumed);
    const unexpectedKind = jobResponse();
    assert.strictEqual(await attachAiExecutionStatus(f.tracked, "unexpected" as AiExecutionKind, unexpectedKind), unexpectedKind);
    assert.equal(f.queryCount(), 0);
  } finally { await f.database.close(); }
});
