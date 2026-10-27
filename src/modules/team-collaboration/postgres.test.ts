import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { PostgresTeamCollaborationRepository } from "./postgres.ts";
import { TeamCollaborationService } from "./service.ts";
import type { TeamSuggestion } from "./types.ts";
import type { SuggestionAudit } from "./repository.ts";

async function setup() {
  const engine = new PGlite(); await engine.waitReady;
  await engine.exec(await readFile(new URL("./migrations/001-team-collaboration.sql", import.meta.url), "utf8"));
  const statements: string[] = [];
  function executor(value: { query: PGlite["query"] }): SqlExecutor {
    return { async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      statements.push(sql);
      const result = await value.query(sql, [...parameters]); return { rows: result.rows as Row[], rowCount: result.affectedRows || result.rows.length };
    } };
  }
  const direct = executor(engine);
  const database: DatabasePort = { query: direct.query, transaction: work => engine.transaction(tx => work(executor(tx))) };
  const repository = new PostgresTeamCollaborationRepository(database);
  return { engine, database, repository, statements };
}
const now = "2026-10-09T04:00:00.000Z";
const suggestion = (id = "suggestion-1", projectId = "project-1"): TeamSuggestion => ({ id, projectId, authorUserId: "user-1", authorMembershipId: "member-1", title: "先验证接口", body: "先运行最小请求，记录返回内容和失败情况。", source: { sourceKind: "space_assistant", sourceId: "answer-1", label: "空间助手回答", revision: 1 }, status: "discussion", revision: 1, createdAt: now, updatedAt: now, adoptedByUserId: null, adoptedAt: null, withdrawnAt: null });
const audit = (value: TeamSuggestion, action: SuggestionAudit["action"] = "published"): SuggestionAudit => ({ id: `audit-${value.id}-${value.revision}`, projectId: value.projectId, suggestionId: value.id, actorUserId: "user-1", action, revision: value.revision, occurredAt: value.updatedAt });

test("Postgres stores isolated projects, immutable versions, CAS and metadata-only withdrawal", async () => {
  const { engine, repository, database } = await setup();
  try {
    const initial = suggestion();
    await repository.transaction(initial.projectId, tx => tx.insert(initial, audit(initial)));
    assert.equal((await repository.transaction("project-2", tx => tx.get(initial.id))), null);
    await repository.transaction(initial.projectId, async tx => {
      const read = (await tx.get(initial.id))!;
      const update = { ...read, title: "先验证真实返回", revision: 2 };
      // PostgreSQL JSONB reorders keys; this source object uses a deliberately different key order.
      update.source = { revision: read.source.revision, label: read.source.label, sourceId: read.source.sourceId, sourceKind: read.source.sourceKind };
      await tx.replace(update, 1, audit(update, "edited"));
    });
    await assert.rejects(repository.transaction(initial.projectId, tx => tx.replace({ ...initial, revision: 2 }, 1, audit({ ...initial, revision: 2 }, "edited"))), { code: "VERSION_CONFLICT", latestRevision: 2 });
    const withdrawn: TeamSuggestion = { ...initial, title: "", body: "", revision: 3, status: "withdrawn", withdrawnAt: now };
    await repository.transaction(initial.projectId, tx => tx.replace(withdrawn, 2, audit(withdrawn, "withdrawn")));
    const stored = await repository.transaction(initial.projectId, tx => tx.get(initial.id));
    assert.equal(stored?.body, ""); assert.equal(stored?.title, "");
    const versions = await database.query<{ revision: number; body: TeamSuggestion }>("SELECT revision,body FROM r02_team_suggestion_versions WHERE suggestion_id=$1 ORDER BY revision", [initial.id]);
    assert.deepEqual(versions.rows.map(row => row.revision), [1, 2, 3]); assert.equal(versions.rows[0]?.body.body, initial.body);
    await assert.rejects(repository.transaction(initial.projectId, tx => tx.replace({ ...withdrawn, revision: 4, status: "discussion", title: "不能恢复", body: "不恢复撤回正文" }, 3, audit({ ...withdrawn, revision: 4 }, "edited"))), { code: "INVALID_INPUT" });
  } finally { await engine.close(); }
});

test("Postgres rolls back insert/version/audit and stores scoped durable idempotency fingerprints", async () => {
  const { engine, repository, database } = await setup();
  try {
    const value = suggestion();
    await assert.rejects(repository.transaction(value.projectId, async tx => { await tx.insert(value, audit(value)); throw new Error("fail before commit"); }), /fail before commit/);
    assert.equal((await database.query("SELECT id FROM r02_team_suggestions")).rows.length, 0);
    assert.equal((await database.query("SELECT id FROM r02_team_suggestion_audit")).rows.length, 0);
    await repository.transaction(value.projectId, async tx => {
      await tx.insert(value, audit(value)); await tx.putReceipt("user-1:publish", "request-1", "hash-1", { id: value.id, revision: 1, status: "discussion", replayed: false });
    });
    assert.equal((await repository.transaction(value.projectId, tx => tx.getReceipt("user-1:publish", "request-1", "hash-1")))?.id, value.id);
    await assert.rejects(repository.transaction(value.projectId, tx => tx.getReceipt("user-1:publish", "request-1", "different")), { code: "IDEMPOTENCY_CONFLICT" });
    assert.equal(await repository.transaction("project-2", tx => tx.getReceipt("user-1:publish", "request-1", "different")), null);
  } finally { await engine.close(); }
});

test("Service plus SQL storage restores uncertain requests without duplicate suggestions and returns no withdrawn body", async () => {
  const { engine, repository } = await setup();
  try {
    const actor = { userId: "user-1", platformRoles: [] } as const; let sequence = 0;
    const service = new TeamCollaborationService({ repository, clock: { now: () => new Date(now) }, ids: { next: () => `id-${++sequence}` },
      access: { async lockAccess(projectId, who, sql) { await sql.query("SELECT 1"); return { membership: { projectId, userId: who.userId, membershipId: "member-1", role: "manager", status: "active" }, readOnly: false }; } },
      sources: { async verifySource({ source }, sql) { await sql.query("SELECT 1"); return { ...source, label: "真实保存来源", revision: 1 }; } },
      activities: { async readActivities() { return []; } } });
    const command = { sourceKind: "space_assistant", sourceId: "answer-1", title: "接口验证", body: "已编辑的明确共享片段", idempotencyKey: "request-1" } as const;
    const saved = await service.publish(actor, "project-1", command);
    assert.equal((await service.publish(actor, "project-1", command)).replayed, true);
    assert.equal((await service.listFeed(actor, "project-1")).items.length, 1);
    await service.withdraw(actor, "project-1", saved.id, { expectedRevision: 1, idempotencyKey: "withdraw-1" });
    const replay = await service.publish(actor, "project-1", command);
    assert.equal(replay.status, "withdrawn"); assert.equal(replay.revision, 2); assert.equal("body" in replay, false);
    assert.deepEqual(await service.listSharedContext(actor, "project-1"), []);
    const feed = await service.listFeed(actor, "project-1"); assert.equal(feed.items[0]?.kind, "unavailable");
    assert.equal(JSON.stringify(feed).includes(command.body), false);
  } finally { await engine.close(); }
});

test("Read snapshots do not take the feed writer lock or initialize heads and cannot mutate", async () => {
  const { engine, repository, database, statements } = await setup();
  try {
    const value = suggestion();
    assert.deepEqual(await repository.readTransaction(value.projectId, tx => tx.list(10)), []);
    assert.equal((await database.query("SELECT project_id FROM r02_team_feed_projects")).rows.length, 0);
    await repository.transaction(value.projectId, tx => tx.insert(value, audit(value)));
    statements.length = 0;
    assert.equal((await repository.readTransaction(value.projectId, tx => tx.get(value.id)))?.id, value.id);
    assert.equal(statements.some(sql => /FOR UPDATE|INSERT INTO r02_team_feed_projects/.test(sql)), false);
    await assert.rejects(repository.readTransaction(value.projectId, tx => tx.insert(suggestion("second"), audit(suggestion("second")))), { code: "READ_ONLY_TRANSACTION" });
    assert.equal((await repository.readTransaction(value.projectId, tx => tx.list(10))).length, 1);
  } finally { await engine.close(); }
});
