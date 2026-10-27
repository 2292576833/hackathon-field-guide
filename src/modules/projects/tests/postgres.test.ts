import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../../shared/errors.ts";
import type { DatabasePort, SqlExecutor, SqlResult } from "../../../shared/persistence.ts";
import type { ProjectAggregate, ProjectFactType } from "../model.ts";
import { PostgresProjectsRepository } from "../postgres.ts";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type SqlCall = { statement: string; parameters: readonly unknown[]; connection: string };
type SimulatedConnection = { tables: Tables; savepoints: Map<string, Tables> };
const time = "2026-10-08T02:00:00.000Z";
const later = "2026-10-08T03:00:00.000Z";

/**
 * A simulated SQL executor for adapter contracts, not PostgreSQL or production storage.
 * It evaluates this adapter's parameterized relational queries and snapshots transaction writes.
 * These tests do not execute the migration or establish PostgreSQL locking/constraint behavior.
 */
class SimulatedSqlDatabase implements DatabasePort {
  tables: Tables;
  readonly calls: SqlCall[] = [];
  transactions = 0;
  commits = 0;
  rollbacks = 0;
  failNextFactInsert = false;
  missNextUpdateTable: string | null = null;

  constructor(tables: Tables = seedTables()) { this.tables = structuredClone(tables); }

  async query<ResultRow = Record<string, unknown>>(statement: string, parameters: readonly unknown[] = []): Promise<SqlResult<ResultRow>> {
    return this.execute<ResultRow>({ tables: this.tables, savepoints: new Map() }, "pool", statement, parameters);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const connection = `transaction-${++this.transactions}`;
    const state: SimulatedConnection = { tables: structuredClone(this.tables), savepoints: new Map() };
    const executor: SqlExecutor = {
      query: <ResultRow = Record<string, unknown>>(statement: string, parameters: readonly unknown[] = []) => this.execute<ResultRow>(state, connection, statement, parameters),
    };
    try {
      const result = await work(executor);
      this.tables = state.tables;
      this.commits++;
      return result;
    } catch (error) { this.rollbacks++; throw error; }
  }

  writes(): SqlCall[] { return this.calls.filter((call) => /^(INSERT|UPDATE|DELETE)\b/.test(call.statement)); }

  private async execute<ResultRow>(state: SimulatedConnection, connection: string, statement: string, parameters: readonly unknown[]): Promise<SqlResult<ResultRow>> {
    this.calls.push({ statement, parameters: structuredClone(parameters), connection });
    let rows: Row[] = [];
    let rowCount = 0;
    const savepoint = statement.match(/^SAVEPOINT (\w+)$/);
    const rollback = statement.match(/^ROLLBACK TO SAVEPOINT (\w+)$/);
    const release = statement.match(/^RELEASE SAVEPOINT (\w+)$/);
    if (savepoint) {
      state.savepoints.set(savepoint[1]!, structuredClone(state.tables));
    } else if (rollback) {
      const snapshot = state.savepoints.get(rollback[1]!);
      assert.ok(snapshot, "rollback must refer to an existing simulated savepoint");
      state.tables = structuredClone(snapshot);
    } else if (release) {
      assert.ok(state.savepoints.has(release[1]!), "release must refer to an existing simulated savepoint");
      state.savepoints.delete(release[1]!);
    } else if (statement.startsWith("SELECT p.* FROM projects_project p JOIN") || statement.startsWith("SELECT t.* FROM projects_team t JOIN")) {
      const join = statement.match(/^SELECT [pt]\.\* FROM (\w+) [pt] JOIN (\w+) m ON m\.(project_id|team_id) = [pt]\.id WHERE (.+?) ORDER BY .+$/);
      assert.ok(join, `unsupported simulated membership JOIN: ${statement}`);
      const condition = join[4]!.replace(/\bm\./g, "");
      const authorized = new Set(this.table(state, join[2]!).filter((row) => this.matches(row, condition, parameters)).map((row) => row[join[3]!]));
      rows = this.table(state, join[1]!).filter((row) => authorized.has(row.id));
    } else if (statement.startsWith("SELECT w.* FROM projects_availability_window w JOIN")) {
      const join = statement.match(/^SELECT w\.\* FROM projects_availability_window w JOIN projects_member_availability a ON a\.id = w\.availability_id WHERE (.+?) ORDER BY .+$/);
      assert.ok(join, `unsupported simulated window JOIN: ${statement}`);
      const condition = join[1]!.replace(/\ba\./g, "");
      const collectionIds = new Set(state.tables.projects_member_availability!.filter((row) => this.matches(row, condition, parameters)).map((row) => row.id));
      rows = state.tables.projects_availability_window!.filter((row) => collectionIds.has(row.availability_id));
    } else if (statement.startsWith("SELECT ")) {
      const select = statement.match(/^SELECT (.+?) FROM (\w+) WHERE (.+?)(?: ORDER BY .+?| LIMIT \$\d+| FOR UPDATE)?$/);
      assert.ok(select, `unsupported simulated SELECT: ${statement}`);
      const table = this.table(state, select[2]!);
      const condition = select[3]!.replace(/ ORDER BY .*| LIMIT .*| FOR UPDATE$/, "");
      rows = table.filter((row) => this.matches(row, condition, parameters));
      const projection = select[1]!;
      if (projection !== "*") rows = rows.map((row) => Object.fromEntries(projection.split(",").map((field) => [field.trim(), row[field.trim()]])));
      const limit = statement.match(/ LIMIT \$(\d+)$/);
      if (limit) rows = rows.slice(0, Number(parameters[Number(limit[1]) - 1]));
    } else if (statement.startsWith("INSERT INTO ")) {
      const insert = statement.match(/^INSERT INTO (\w+) \((.+?)\) VALUES \((.+?)\)$/);
      assert.ok(insert, `unsupported simulated INSERT: ${statement}`);
      if (insert[1] === "projects_change_fact" && this.failNextFactInsert) {
        this.failNextFactInsert = false;
        throw new Error("simulated fact insertion failure");
      }
      const values = insert[3]!.split(",").map((parameter) => {
        const placeholder = parameter.match(/^\$(\d+)(?:::jsonb)?$/);
        assert.ok(placeholder, "all simulated INSERT values must be parameters");
        return structuredClone(parameters[Number(placeholder[1]) - 1]);
      });
      const record = Object.fromEntries(insert[2]!.split(",").map((column, index) => [column.trim(), values[index]]));
      this.table(state, insert[1]!).push(record);
      rowCount = 1;
    } else if (statement.startsWith("UPDATE ")) {
      const update = statement.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/);
      assert.ok(update, `unsupported simulated UPDATE: ${statement}`);
      if (this.missNextUpdateTable === update[1]) {
        this.missNextUpdateTable = null;
        return { rows: [], rowCount: 0 };
      }
      for (const row of this.table(state, update[1]!)) {
        if (!this.matches(row, update[3]!, parameters)) continue;
        for (const assignment of update[2]!.split(",")) {
          const value = assignment.trim().match(/^(\w+)\s*=\s*(?:\$(\d+)|(CURRENT_TIMESTAMP))$/);
          assert.ok(value, "all simulated UPDATE values must be parameters or the database timestamp");
          row[value[1]!] = value[3] ? new Date(later) : structuredClone(parameters[Number(value[2]) - 1]);
        }
        rowCount++;
      }
    } else if (statement.startsWith("DELETE FROM ")) {
      const remove = statement.match(/^DELETE FROM (\w+) WHERE (.+)$/);
      assert.ok(remove, `unsupported simulated DELETE: ${statement}`);
      const original = this.table(state, remove[1]!);
      state.tables[remove[1]!] = original.filter((row) => !this.matches(row, remove[2]!, parameters));
      rowCount = original.length - state.tables[remove[1]!]!.length;
    } else {
      assert.fail(`unsupported simulated SQL: ${statement}`);
    }
    return { rows: structuredClone(rows) as ResultRow[], rowCount: statement.startsWith("SELECT ") ? rows.length : rowCount };
  }

  private table(state: SimulatedConnection, table: string): Row[] {
    const rows = state.tables[table];
    assert.ok(rows, `unknown simulated table: ${table}`);
    return rows;
  }

  private matches(row: Row, condition: string, parameters: readonly unknown[]): boolean {
    return condition.split(/\s+AND\s+/).every((predicate) => {
      const parameter = predicate.match(/^(\w+)\s*=\s*\$(\d+)$/);
      if (parameter) {
        const field = parameter[1]!;
        const expected = parameters[Number(parameter[2]) - 1];
        // Driver fixtures may serialize integers as strings; SQL still compares numeric columns.
        if (["revision", "version", "membership_revision"].includes(field)) return Number(row[field]) === Number(expected);
        return row[field] === expected;
      }
      const literal = predicate.match(/^(\w+)\s*=\s*'([^']*)'$/);
      if (literal) return row[literal[1]!] === literal[2];
      const isNull = predicate.match(/^(\w+) IS NULL$/);
      if (isNull) return row[isNull[1]!] === null || row[isNull[1]!] === undefined;
      assert.fail(`unsupported simulated predicate: ${predicate}`);
    });
  }
}

function seedTables(): Tables {
  const project = (id: string, createdBy: string): Row => ({ id, name: `项目 ${id}`, team_id: null, event_id: null, created_by: createdBy, goal: "完成演示", minimum_deliverable: "页面与文档", stage: "draft", timezone: "Asia/Shanghai", deadline: null, deadline_source: "unknown", revision: 1, created_at: new Date(time), updated_at: new Date(time) });
  const team = (id: string, createdBy: string): Row => ({ id, name: `队伍 ${id}`, created_by: createdBy, status: "active", revision: 1, created_at: new Date(time), updated_at: new Date(time) });
  const projectMember = (membershipId: string, projectId: string, userId: string, status: string, role = "member"): Row => ({ membership_id: membershipId, project_id: projectId, user_id: userId, role, status, revision: status === "active" ? 3 : 2, joined_at: new Date(time), left_at: status === "active" ? null : new Date(later) });
  const teamMember = (membershipId: string, teamId: string, userId: string, status: string, role = "member"): Row => ({ membership_id: membershipId, team_id: teamId, user_id: userId, role, status, revision: 1, joined_at: new Date(time), left_at: status === "active" ? null : new Date(later) });
  return {
    projects_project: [project("p1", "alice"), project("p2", "bob")],
    projects_team: [team("t1", "alice"), team("t2", "bob")],
    projects_project_membership: [projectMember("m-bob", "p1", "bob", "active", "manager"), projectMember("m-alice", "p1", "alice", "left"), projectMember("m-carol", "p1", "carol", "removed"), projectMember("m-dave", "p2", "dave", "active", "manager"), projectMember("m-carol-p2", "p2", "carol", "active")],
    projects_team_membership: [teamMember("tm-alice", "t1", "alice", "active", "captain"), teamMember("tm-bob", "t1", "bob", "active"), teamMember("tm-bob-removed", "t2", "bob", "removed"), teamMember("tm-dave", "t2", "dave", "active", "captain")],
    projects_invitation: [{ id: "i1", scope_type: "project", scope_id: "p1", project_id: "p1", team_id: null, token_hash: "hash1", role: "member", invited_email: null, created_by: "bob", created_at: new Date(time), expires_at: new Date("2026-10-11T02:00:00.000Z"), status: "pending", accepted_by: null, accepted_at: null, revoked_at: null, revision: 1 }],
    projects_invitation_acceptance: [],
    projects_member_availability: [{ id: "a1", project_id: "p1", user_id: "bob", timezone: "Asia/Shanghai", effective_minutes: "40.75", confirmed_at: new Date(time), revision: "2", membership_revision: "1" }, { id: "a2", project_id: "p2", user_id: "carol", timezone: "Asia/Shanghai", effective_minutes: 200, confirmed_at: new Date(time), revision: 1, membership_revision: 3 }],
    projects_availability_window: [{ availability_id: "a1", id: "w1", starts_at: new Date(time), ends_at: new Date(later), effective_minutes: "30.5", revision: 2 }, { availability_id: "a1", id: "w-removed", starts_at: new Date(later), ends_at: new Date("2026-10-08T04:00:00.000Z"), effective_minutes: 10.25, revision: 2 }, { availability_id: "a2", id: "w1", starts_at: new Date(time), ends_at: new Date(later), effective_minutes: 99, revision: 1 }, { availability_id: "a2", id: "w-removed", starts_at: new Date(later), ends_at: new Date("2026-10-08T04:00:00.000Z"), effective_minutes: 101, revision: 1 }],
    projects_resource_bookmark: [{ id: "b1", project_id: "p1", resource_id: "resource1", resource_version: 1, url: null, title: "组件参考", purpose_note: "界面实现", saved_by: "alice", saved_at: new Date(time), status: "active", source_status: "reviewed_resource", revision: 1 }],
    projects_activity: [{ id: "history1", project_id: "p1", actor_id: "alice", type: "scope_changed", object_id: "p1", before_summary: '{"goal":"旧目标"}', after_summary: { goal: "完成演示" }, occurred_at: new Date(time), revision: "1" }],
    projects_change_fact: [{ event_id: "old-fact", type: "ProjectCreated", aggregate_id: "p1", project_id: "p1", actor_id: "alice", version: "1", occurred_at: new Date(time), payload: '{"stage":"draft"}', acknowledged_at: null }],
  };
}

function setup(tables?: Tables) {
  const database = new SimulatedSqlDatabase(tables);
  return { database, repository: new PostgresProjectsRepository(database) };
}

function appendChange(aggregate: ProjectAggregate, type: ProjectFactType = "ProjectScopeChanged") {
  aggregate.activities.push({ id: "new-activity", projectId: aggregate.project.id, actorId: "bob", type: "changed", objectId: aggregate.project.id, beforeSummary: { revision: 1 }, afterSummary: { revision: aggregate.project.revision }, occurredAt: later, revision: aggregate.project.revision });
  aggregate.facts.push({ eventId: "new-fact", type, aggregateId: aggregate.project.id, projectId: aggregate.project.id, actorId: "bob", version: aggregate.project.revision, occurredAt: later, payload: { changed: true } });
}

test("simulated SQL: actor, project and token identifiers stay in bound parameters", async () => {
  const tables = seedTables();
  const projectId = "project'; DROP TABLE users; --";
  const userId = "user' OR true --";
  const tokenHash = "hash' OR true --";
  tables.projects_project![0]!.id = projectId;
  tables.projects_project_membership![0]!.project_id = projectId;
  tables.projects_project_membership![0]!.user_id = userId;
  tables.projects_invitation![0]!.token_hash = tokenHash;
  tables.projects_invitation![0]!.scope_id = projectId;
  const { database, repository } = setup(tables);
  assert.equal((await repository.getMembership(projectId, userId))?.userId, userId);
  assert.deepEqual((await repository.listProjects(userId)).map((item) => item.id), [projectId]);
  assert.deepEqual(await repository.findInvitationByHash(tokenHash), { scopeType: "project", scopeId: projectId });
  assert.deepEqual(database.calls[0]!.parameters, [projectId, userId]);
  assert.deepEqual(database.calls[1]!.parameters, [userId]);
  assert.deepEqual(database.calls[2]!.parameters, [tokenHash]);
  for (const call of database.calls) for (const identity of [projectId, userId, tokenHash]) assert.equal(call.statement.includes(identity), false);
});

test("simulated SQL: access lookup preserves left/removed while lists require active membership", async () => {
  const { repository } = setup();
  assert.equal((await repository.getMembership("p1", "alice"))?.status, "left");
  assert.equal((await repository.getMembership("p1", "carol"))?.status, "removed");
  assert.equal(await repository.getMembership("p1", "unknown"), null);
  assert.deepEqual(await repository.listProjects("alice"), []);
  assert.deepEqual((await repository.listProjects("bob")).map((item) => item.id), ["p1"]);
  assert.deepEqual((await repository.listProjects("carol")).map((item) => item.id), ["p2"]);
  assert.deepEqual((await repository.listTeams("bob")).map((item) => item.id), ["t1"]);
});

test("simulated SQL: project is locked before members and no-op aggregate does not write", async () => {
  const { database, repository } = setup();
  await repository.withProject("p1", async (aggregate) => {
    assert.deepEqual(aggregate.activities, []);
    assert.deepEqual(aggregate.facts, []);
    assert.deepEqual(aggregate.availability.map((item) => item.id), ["a1"]);
    assert.equal(aggregate.availability[0]!.windows.length, 2);
    assert.equal(aggregate.members.find((item) => item.userId === "alice")?.status, "left");
    await repository.listActivities("p1", 10);
    await repository.listProjects("bob");
    await repository.getMembership("p1", "bob");
  });
  const lock = database.calls.findIndex((call) => call.statement.includes("FROM projects_project WHERE") && call.statement.endsWith("FOR UPDATE"));
  const members = database.calls.findIndex((call) => call.statement.includes("FROM projects_project_membership"));
  assert.ok(lock >= 0 && members > lock);
  assert.deepEqual(database.calls[lock]!.parameters, ["p1"]);
  assert.equal(database.calls.every((call) => call.connection === "transaction-1"), true);
  assert.deepEqual(database.writes(), []);
  assert.equal(database.commits, 1);
});

test("simulated SQL: Date, JSON string/object and decimal minute fields are normalized", async () => {
  const { repository } = setup();
  await repository.withProject("p1", async (aggregate) => {
    assert.equal(aggregate.project.createdAt, time);
    assert.equal(aggregate.members.find((item) => item.userId === "alice")?.leftAt, later);
    assert.equal(aggregate.availability[0]!.effectiveMinutes, 40.75);
    assert.equal(aggregate.availability[0]!.membershipRevision, 1);
    assert.equal(aggregate.availability[0]!.windows[0]!.startsAt, time);
    assert.equal(aggregate.availability[0]!.windows[0]!.effectiveMinutes, 30.5);
    const activities = await repository.listActivities("p1", 10);
    assert.deepEqual(activities[0]!.beforeSummary, { goal: "旧目标" });
    assert.deepEqual(activities[0]!.afterSummary, { goal: "完成演示" });
    assert.equal(activities[0]!.occurredAt, time);
    const facts = await repository.listPendingFacts(10);
    assert.deepEqual(facts[0]!.payload, { stage: "draft" });
    assert.equal(facts[0]!.version, 1);
    assert.equal(facts[0]!.occurredAt, time);
  });
});

test("simulated SQL: only changed rows are persisted with append-only activity and fact on one connection", async () => {
  const { database, repository } = setup();
  const before = structuredClone(database.tables);
  await repository.withProject("p1", async (aggregate) => {
    aggregate.project.name = "新项目名称";
    aggregate.project.revision++;
    aggregate.project.updatedAt = later;
    const removedMember = aggregate.members.find((item) => item.userId === "carol")!;
    removedMember.role = "manager";
    removedMember.revision++;
    appendChange(aggregate);
  });
  assert.equal(database.tables.projects_project![0]!.name, "新项目名称");
  assert.equal(database.tables.projects_project_membership!.find((row) => row.user_id === "carol" && row.project_id === "p1")!.role, "manager");
  assert.deepEqual(database.tables.projects_project_membership!.filter((row) => row.user_id !== "carol"), before.projects_project_membership!.filter((row) => row.user_id !== "carol"));
  for (const table of ["projects_invitation", "projects_member_availability", "projects_availability_window", "projects_resource_bookmark"]) assert.deepEqual(database.tables[table], before[table]);
  assert.deepEqual(database.tables.projects_activity![0], before.projects_activity![0]);
  assert.deepEqual(database.tables.projects_change_fact![0], before.projects_change_fact![0]);
  assert.equal(database.tables.projects_activity!.length, 2);
  assert.equal(database.tables.projects_change_fact!.length, 2);
  assert.equal(database.writes().length, 4);
  assert.equal(database.writes().every((call) => call.connection === "transaction-1"), true);
  assert.deepEqual(database.writes()[1]!.parameters.slice(-2), ["p1", 2]);
});

test("simulated SQL: fact insertion failure rolls back earlier scope and activity writes", async () => {
  const { database, repository } = setup();
  const before = structuredClone(database.tables);
  database.failNextFactInsert = true;
  await assert.rejects(repository.withProject("p1", async (aggregate) => {
    aggregate.project.name = "不能留下的更改";
    aggregate.project.revision++;
    appendChange(aggregate);
  }), /simulated fact insertion failure/);
  assert.equal(database.writes().some((call) => call.statement.startsWith("INSERT INTO projects_activity")), true);
  assert.deepEqual(database.tables, before);
  assert.equal(database.transactions, 1);
  assert.equal(database.commits, 0);
  assert.equal(database.rollbacks, 1);
});

test("simulated SQL: an optimistic UPDATE miss rejects stale persistence and rolls back earlier writes", async () => {
  const { database, repository } = setup();
  const before = structuredClone(database.tables);
  database.missNextUpdateTable = "projects_project_membership";
  await assert.rejects(repository.withProject("p1", async (aggregate) => {
    aggregate.project.name = "发生冲突的更改";
    aggregate.project.revision++;
    const membership = aggregate.members.find((member) => member.userId === "carol")!;
    membership.role = "manager";
    membership.revision++;
  }), (error: unknown) => error instanceof DomainError && error.code === "VERSION_CONFLICT" && error.status === 409);
  assert.equal(database.writes().some((call) => call.statement.startsWith("UPDATE projects_project SET")), true);
  const memberUpdate = database.writes().find((call) => call.statement.startsWith("UPDATE projects_project_membership"))!;
  assert.ok(memberUpdate.statement.includes("revision=$8"));
  assert.deepEqual(memberUpdate.parameters.slice(-2), ["p1", 2]);
  assert.deepEqual(database.tables, before);
  assert.equal(database.commits, 0);
  assert.equal(database.rollbacks, 1);
});

test("simulated SQL: Team then Project nesting shares one transaction and uses a savepoint", async () => {
  const { database, repository } = setup();
  await repository.withTeam("t1", async (team) => {
    await repository.withProject("p1", async (aggregate) => {
      aggregate.project.teamId = team.team.id;
      aggregate.project.revision++;
    });
    assert.deepEqual((await repository.listProjects("bob")).map((item) => item.id), ["p1"]);
    assert.deepEqual((await repository.listTeams("bob")).map((item) => item.id), ["t1"]);
  });
  assert.equal(database.transactions, 1);
  assert.equal(database.commits, 1);
  assert.equal(database.tables.projects_project![0]!.team_id, "t1");
  const teamLock = database.calls.findIndex((call) => call.statement.includes("FROM projects_team WHERE") && call.statement.endsWith("FOR UPDATE"));
  const projectLock = database.calls.findIndex((call) => call.statement.includes("FROM projects_project WHERE") && call.statement.endsWith("FOR UPDATE"));
  assert.ok(teamLock >= 0 && projectLock > teamLock);
  assert.equal(database.calls.filter((call) => call.statement.startsWith("SAVEPOINT ")).length, 1);
  assert.equal(database.calls.filter((call) => call.statement.startsWith("RELEASE SAVEPOINT ")).length, 1);
  assert.equal(database.calls.every((call) => call.connection === "transaction-1"), true);
});

test("simulated SQL: rejected nested writes roll back to their savepoint while outer work can commit", async () => {
  const { database, repository } = setup();
  const projectBefore = structuredClone(database.tables.projects_project);
  const activitiesBefore = structuredClone(database.tables.projects_activity);
  database.failNextFactInsert = true;
  await repository.withTeam("t1", async (team) => {
    await assert.rejects(repository.withProject("p1", async (aggregate) => {
      aggregate.project.name = "失败的项目更改";
      aggregate.project.revision++;
      appendChange(aggregate);
    }), /simulated fact insertion failure/);
    team.team.name = "成功的队伍更改";
    team.team.revision++;
  });
  assert.equal(database.tables.projects_team![0]!.name, "成功的队伍更改");
  assert.deepEqual(database.tables.projects_project, projectBefore);
  assert.deepEqual(database.tables.projects_activity, activitiesBefore);
  assert.equal(database.transactions, 1);
  assert.equal(database.commits, 1);
  assert.equal(database.calls.filter((call) => call.statement.startsWith("ROLLBACK TO SAVEPOINT ")).length, 1);
});

test("simulated SQL: external membership lookup locks Project first and returns historical status", async () => {
  const { database, repository } = setup();
  await database.transaction(async (executor) => {
    assert.equal((await repository.getMembershipForUpdate(executor, "p1", "alice"))?.status, "left");
    assert.equal((await repository.getMembershipForUpdate(executor, "p1", "carol"))?.status, "removed");
    assert.equal(await repository.getMembershipForUpdate(executor, "missing", "bob"), null);
  });
  assert.equal(database.transactions, 1);
  assert.ok(database.calls[0]!.statement.endsWith("FOR UPDATE"));
  assert.deepEqual(database.calls[0]!.parameters, ["p1"]);
  assert.deepEqual(database.calls[1]!.parameters, ["p1", "alice"]);
  assert.equal(database.calls.every((call) => call.connection === "transaction-1"), true);
});

test("simulated SQL: external planning context retains history and stale availability but refuses a departed creator", async () => {
  const { database, repository } = setup();
  await database.transaction(async (executor) => {
    const context = await repository.getPlanningContextForUpdate(executor, "p1", "bob");
    assert.equal(context.project.createdBy, "alice");
    assert.equal(context.members.find((item) => item.userId === "alice")?.status, "left");
    assert.equal(context.members.find((item) => item.userId === "carol")?.status, "removed");
    assert.equal(context.members.find((item) => item.userId === "bob")?.revision, 3);
    assert.equal(context.availability[0]!.membershipRevision, 1);
    assert.equal(context.availability[0]!.effectiveMinutes, 40.75);
    await assert.rejects(repository.getPlanningContextForUpdate(executor, "p1", "alice"), (error: unknown) => error instanceof DomainError && error.code === "PROJECT_NOT_FOUND" && error.status === 404);
  });
  assert.equal(database.transactions, 1);
  assert.equal(database.calls.every((call) => call.connection === "transaction-1"), true);
  assert.equal(database.writes().length, 0);
});

test("simulated SQL: current collection, changed/added/removed windows and fact are saved in the same transaction", async () => {
  const { database, repository } = setup();
  const membersBefore = structuredClone(database.tables.projects_project_membership);
  const otherCollectionBefore = structuredClone(database.tables.projects_member_availability!.filter((row) => row.project_id === "p2"));
  const otherWindowsBefore = structuredClone(database.tables.projects_availability_window!.filter((row) => row.availability_id === "a2"));
  await repository.withProject("p1", async (aggregate) => {
    aggregate.project.revision++;
    const collection = aggregate.availability[0]!;
    collection.revision++;
    collection.membershipRevision = 3;
    collection.confirmedAt = later;
    collection.windows = [{ ...collection.windows[0]!, revision: 3, effectiveMinutes: 25.25 }, { id: "w-new", startsAt: later, endsAt: "2026-10-08T04:00:00.000Z", effectiveMinutes: 15.5, revision: 3 }];
    collection.effectiveMinutes = 40.75;
    appendChange(aggregate, "MemberAvailabilityChanged");
  });
  assert.equal(database.tables.projects_member_availability![0]!.revision, 3);
  assert.equal(database.tables.projects_member_availability![0]!.membership_revision, 3);
  assert.deepEqual(database.tables.projects_availability_window!.filter((row) => row.availability_id === "a1").map((row) => row.id).sort(), ["w-new", "w1"]);
  assert.equal(database.tables.projects_availability_window!.find((row) => row.availability_id === "a1" && row.id === "w1")!.effective_minutes, 25.25);
  assert.equal(database.tables.projects_availability_window!.find((row) => row.availability_id === "a1" && row.id === "w-new")!.effective_minutes, 15.5);
  assert.deepEqual(database.tables.projects_member_availability!.filter((row) => row.project_id === "p2"), otherCollectionBefore);
  assert.deepEqual(database.tables.projects_availability_window!.filter((row) => row.availability_id === "a2"), otherWindowsBefore);
  assert.deepEqual(database.tables.projects_project_membership, membersBefore);
  assert.equal(database.tables.projects_change_fact!.at(-1)!.type, "MemberAvailabilityChanged");
  assert.equal(database.writes().every((call) => call.connection === "transaction-1"), true);
  assert.equal(database.writes().filter((call) => call.statement.startsWith("DELETE FROM ")).length, 1);
  assert.ok(database.writes().find((call) => call.statement.startsWith("DELETE FROM "))!.statement.startsWith("DELETE FROM projects_availability_window"));
  await repository.withProject("p1", async (aggregate) => {
    assert.equal(aggregate.availability[0]!.revision, 3);
    assert.deepEqual(aggregate.availability[0]!.windows.map((window) => window.id).sort(), ["w-new", "w1"]);
    assert.deepEqual(aggregate.activities, []);
    assert.deepEqual(aggregate.facts, []);
  });
  assert.equal(database.writes().some((call) => call.connection === "transaction-2"), false);
});
