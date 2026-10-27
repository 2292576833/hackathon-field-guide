import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { AssistantMessage } from "./model.ts";
import {
  clearMessages, ensureConversation, finishRequest, insertMessage, insertRequest,
  readLastRequest, readMessage, readMessages, readRequest, readUncertainRequestByHash, updateSession,
} from "./postgres.ts";
import type { AssistantRequestRow } from "./postgres.ts";

const now = "2026-10-09T09:00:00.000Z";
const later = "2026-10-09T09:01:00.000Z";
const expiresAt = "2026-10-09T09:05:00.000Z";

/** Fresh in-memory engine only: never reads .env or a production PGlite directory. */
async function fixture(work: (sql: SqlExecutor, db: PGlite) => Promise<void>): Promise<void> {
  const db = new PGlite();
  const sql: SqlExecutor = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await db.query<Row>(statement, [...parameters]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    await db.exec("CREATE TABLE auth_users (id text PRIMARY KEY); CREATE TABLE projects_project (id text PRIMARY KEY)");
    await db.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
    await sql.query("INSERT INTO auth_users (id) VALUES ($1),($2)", ["user-a", "user-b"]);
    await sql.query("INSERT INTO projects_project (id) VALUES ($1),($2)", ["project-a", "project-b"]);
    await work(sql, db);
  } finally { await db.close(); }
}

function request(userId = "user-a", projectId = "project-a", requestId = "request-a", requestHash = "same-hash"): AssistantRequestRow {
  return { userId, projectId, requestId, requestHash, message: "怎样检查我的交付？", status: "running",
    responseId: null, errorCode: null, createdAt: now, expiresAt };
}
function userMessage(id = "z-user"): AssistantMessage {
  return { id, role: "user", content: "怎样检查我的交付？", createdAt: now, provider: null, links: [], coverage: null };
}
function assistantMessage(id = "a-answer"): AssistantMessage {
  return { id, role: "assistant", content: "先运行约定的演示，再请负责人检查。", createdAt: now, provider: "dsh",
    links: [{ id: "task-board", label: "团队任务", href: "/projects/project-a/tasks" }],
    coverage: { contextFingerprint: "context-1", memoryFingerprint: "memory-1",
      memory: { retainedCount: 20, selectedCount: 3, description: "本次选择 3 条本人记忆" },
      sources: [{ id: "plan-1", label: "当前计划" }], missing: ["未提供真实运行结果"], capturedAt: now } };
}
async function seedPair(sql: SqlExecutor, row: AssistantRequestRow): Promise<void> {
  await ensureConversation(sql, row.userId, row.projectId, now);
  await insertRequest(sql, row);
  await insertMessage(sql, row.userId, row.projectId, row.requestId, userMessage());
  await insertMessage(sql, row.userId, row.projectId, row.requestId, assistantMessage());
}

test("messages and requests stay private across users and projects, including shared IDs", async () => {
  await fixture(async sql => {
    const scopes = [["user-a", "project-a"], ["user-b", "project-a"], ["user-a", "project-b"]] as const;
    for (const [userId, projectId] of scopes) await seedPair(sql, request(userId, projectId));
    assert.deepEqual(await readMessages(sql, "user-a", "project-a"), [userMessage(), assistantMessage()]);
    assert.equal((await readMessage(sql, "user-b", "project-a", "a-answer"))?.role, "assistant");
    assert.equal(await readMessage(sql, "user-b", "project-b", "a-answer"), null);
    assert.equal(await readRequest(sql, "user-b", "project-b", "request-a"), null);
    assert.equal(await readLastRequest(sql, "user-b", "project-b"), null);
    assert.equal(await readUncertainRequestByHash(sql, "user-b", "project-b", "same-hash"), null);
    assert.equal(await finishRequest(sql, "user-b", "project-b", "request-a", "unknown", null, "UNKNOWN"), false);
    await clearMessages(sql, "user-a", "project-a");
    assert.deepEqual(await readMessages(sql, "user-a", "project-a"), []);
    assert.equal((await readMessages(sql, "user-b", "project-a")).length, 2);
    assert.equal((await readMessages(sql, "user-a", "project-b")).length, 2);
    assert.equal((await readRequest(sql, "user-a", "project-a", "request-a"))?.message, "怎样检查我的交付？");
  });
});

test("conversation creation is idempotent and version CAS rejects competing or stale writers", async () => {
  await fixture(async (sql, db) => {
    const first = await ensureConversation(sql, "user-a", "project-a", now);
    assert.deepEqual(first, { userId: "user-a", projectId: "project-a", revision: 0,
      activeRequestId: null, createdAt: now, updatedAt: now });
    assert.deepEqual(await ensureConversation(sql, "user-a", "project-a", later), first);
    const candidates = await Promise.all([
      updateSession(sql, "user-a", "project-a", 0, "request-a", later),
      updateSession(sql, "user-a", "project-a", 0, "request-b", later),
    ]);
    assert.equal(candidates.filter(value => value !== null).length, 1);
    assert.equal(candidates.find(value => value !== null)?.revision, 1);
    assert.equal(await updateSession(sql, "user-a", "project-a", 0, null, later), null);
    assert.equal(await updateSession(sql, "user-b", "project-a", 1, null, later), null);
    assert.equal((await updateSession(sql, "user-a", "project-a", 1, null, later))?.revision, 2);
    await assert.rejects(db.transaction(async tx => {
      const executor: SqlExecutor = { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
        const result = await tx.query<Row>(statement, [...parameters]);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      } };
      await updateSession(executor, "user-a", "project-a", 2, "rolled-back", later);
      throw new Error("abort transaction");
    }), /abort transaction/);
    assert.equal((await ensureConversation(sql, "user-a", "project-a", later)).revision, 2);
  });
});

test("unknown holds survive clearing and terminal requests cannot be rewritten", async () => {
  await fixture(async sql => {
    await seedPair(sql, request());
    assert.equal(await finishRequest(sql, "user-a", "project-a", "request-a", "unknown", null, "TIMEOUT_UNKNOWN"), true);
    assert.equal(await finishRequest(sql, "user-a", "project-a", "request-a", "failed", null, "RETRY"), false);
    assert.equal(await finishRequest(sql, "user-a", "project-a", "request-a", "succeeded", "a-answer", null), false);
    await clearMessages(sql, "user-a", "project-a");
    assert.equal((await readUncertainRequestByHash(sql, "user-a", "project-a", "same-hash"))?.status, "unknown");
    assert.equal((await readRequest(sql, "user-a", "project-a", "request-a"))?.errorCode, "TIMEOUT_UNKNOWN");
    await insertRequest(sql, request("user-a", "project-a", "request-b", "new-hash"));
    assert.equal(await finishRequest(sql, "user-a", "project-a", "request-b", "running", null, null), false);
    assert.equal(await finishRequest(sql, "user-a", "project-a", "request-b", "failed", null, "BEFORE_RUN"), true);
    assert.equal(await readUncertainRequestByHash(sql, "user-a", "project-a", "new-hash"), null);
    assert.equal((await readLastRequest(sql, "user-a", "project-a"))?.requestId, "request-b");
  });
});

test("request identity sequence supplies stable latest ordering when timestamps and IDs conflict", async () => {
  await fixture(async sql => {
    await ensureConversation(sql, "user-a", "project-a", now);
    await insertRequest(sql, request("user-a", "project-a", "z-first"));
    await insertRequest(sql, request("user-a", "project-a", "a-second"));
    assert.equal((await readLastRequest(sql, "user-a", "project-a"))?.requestId, "a-second");
    assert.equal((await readUncertainRequestByHash(sql, "user-a", "project-a", "same-hash"))?.requestId, "a-second");
    assert.equal(await finishRequest(sql, "user-a", "project-a", "a-second", "succeeded", "answer-second", null), true);
    assert.equal((await readUncertainRequestByHash(sql, "user-a", "project-a", "same-hash"))?.requestId, "z-first");
    await assert.rejects(insertRequest(sql, request("user-a", "project-a", "z-first")), /duplicate key/i);
  });
});

test("reading a recent window never prunes long history and old responses can still be replayed", async () => {
  await fixture(async sql => {
    await ensureConversation(sql, "user-a", "project-a", now);
    for (let index = 0; index < 65; index++) {
      const id = `request-${index}`;
      await insertRequest(sql, request("user-a", "project-a", id, `hash-${index}`));
      await insertMessage(sql, "user-a", "project-a", id, userMessage(`user-${index}`));
      await insertMessage(sql, "user-a", "project-a", id, assistantMessage(`answer-${index}`));
    }
    const recent = await readMessages(sql, "user-a", "project-a");
    assert.equal(recent.length, 100);
    assert.equal(recent[0]?.id, "user-15");
    assert.equal(recent[99]?.id, "answer-64");
    assert.deepEqual(await readMessage(sql, "user-a", "project-a", "answer-0"), assistantMessage("answer-0"));
    const all = await readMessages(sql, "user-a", "project-a", 500);
    assert.equal(all.length, 130);
    assert.equal(all[0]?.id, "user-0");
    assert.deepEqual(await readMessages(sql, "user-a", "project-a", 0), []);
    await assert.rejects(readMessages(sql, "user-a", "project-a", -1), RangeError);
    await assert.rejects(readMessages(sql, "user-a", "project-a", 1.5), RangeError);
    assert.equal((await readMessages(sql, "user-a", "project-a", 500)).length, 130);
  });
});

test("schema rejects cross-scope ownership and non-DSH assistant responses", async () => {
  await fixture(async sql => {
    await ensureConversation(sql, "user-a", "project-a", now);
    await insertRequest(sql, request());
    await assert.rejects(insertMessage(sql, "user-b", "project-a", "request-a", userMessage()), /foreign key/i);
    await assert.rejects(insertMessage(sql, "user-a", "project-b", "request-a", userMessage()), /foreign key/i);
    await assert.rejects(insertMessage(sql, "user-a", "project-a", "request-a", { ...assistantMessage(), provider: null }), /check constraint/i);
    await insertMessage(sql, "user-a", "project-a", "request-a", userMessage());
    await assert.rejects(insertMessage(sql, "user-a", "project-a", "request-a", userMessage("other-user-message")), /duplicate key/i);
  });
});

test("all caller text stays in bound parameters and conversation initialization obtains FOR UPDATE", async () => {
  const calls: { statement: string; parameters: readonly unknown[] }[] = [];
  const attack = "x'; DROP TABLE team_assistant_messages; --";
  const sql: SqlExecutor = { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
    calls.push({ statement, parameters });
    const rows = statement.includes("FOR UPDATE") ? [{ user_id: attack, project_id: attack, revision: 0,
      active_request_id: null, created_at: new Date(now), updated_at: new Date(now) }] : [];
    return { rows: rows as Row[], rowCount: rows.length };
  } };
  assert.equal((await ensureConversation(sql, attack, attack, now)).createdAt, now);
  await readMessages(sql, attack, attack);
  await readMessage(sql, attack, attack, attack);
  await readRequest(sql, attack, attack, attack);
  await readLastRequest(sql, attack, attack);
  await readUncertainRequestByHash(sql, attack, attack, attack);
  await insertRequest(sql, { ...request(attack, attack, attack, attack), message: attack });
  await updateSession(sql, attack, attack, 0, attack, now);
  await finishRequest(sql, attack, attack, attack, "unknown", attack, attack);
  await insertMessage(sql, attack, attack, attack, { ...userMessage(attack), content: attack });
  await clearMessages(sql, attack, attack);
  assert.match(calls[0]!.statement, /ON CONFLICT \(user_id, project_id\) DO NOTHING/);
  assert.match(calls[1]!.statement, /FOR UPDATE$/);
  assert.ok(calls.every(call => !call.statement.includes(attack)));
  assert.ok(calls.every(call => call.parameters.includes(attack)));
});
