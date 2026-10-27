import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope, HostedEventAccessPort, OrganizerPrincipal, EventStaffCapability } from "../../shared/organizer-contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { createEventRegistrationService } from "./service.ts";
import type { RegistrationAnswers, RegistrationField } from "./model.ts";

export const TEST_NOW = "2026-10-11T03:00:00.000Z";
export const DEFAULT_FIELDS: RegistrationField[] = [{ id: "goal", type: "text", label: "想做什么", description: "", required: true, maxLength: 300 }];
export function eventScope(eventId = "event-a", organizationId = "org-a"): HostedEventScope {
  return { eventId, organizationId, organizationName: organizationId, title: `比赛 ${eventId}`, status: "published", revision: 1, publishedRevision: 1,
    timezone: "Asia/Shanghai", startsAt: "2026-10-12T01:00:00.000Z", endsAt: "2026-10-13T10:00:00.000Z",
    registrationOpensAt: "2026-10-10T00:00:00.000Z", registrationClosesAt: "2026-10-12T00:00:00.000Z", submissionClosesAt: "2026-10-13T09:00:00.000Z",
    modules: { registration: true, teams: true, icebreaking: false, judging: false, schedule: false, accommodation: false, mealVouchers: false },
    registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 3, locksAt: "2026-10-12T00:00:00.000Z" }, linkedEventId: null };
}

/** A new in-memory engine only: no environment file, live application, disk database or network. */
export async function registrationFixture(options: { preview?: boolean } = {}) {
  const engine = new PGlite(); await engine.waitReady;
  await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY, active boolean NOT NULL DEFAULT true, session_active boolean NOT NULL DEFAULT true, project_manager boolean NOT NULL DEFAULT false); INSERT INTO auth_users(id,project_manager) VALUES ('alice',false),('bob',false),('carol',false),('dave',false),('staff',false),('team-staff',false),('manager',true); CREATE TABLE fixture_root_links(event_id text,team_id text,project_id text,PRIMARY KEY(event_id,team_id));");
  await engine.exec(await readFile(new URL("./sql/001-event-registration.sql", import.meta.url), "utf8"));
  const statements: string[] = []; const transactionExecutors = new Set<SqlExecutor>();
  const executor = (target: { query: PGlite["query"] }): SqlExecutor => ({ async query<Row>(statement: string, parameters: readonly unknown[] = []) {
    statements.push(statement); const result = await target.query(statement, [...parameters]); return { rows: result.rows as Row[], rowCount: result.affectedRows || result.rows.length };
  } });
  const direct = executor(engine);
  const database: DatabasePort = { query: direct.query, transaction: work => engine.transaction(async tx => { const sql = executor(tx); transactionExecutors.add(sql); return work(sql); }) };
  const scopes = new Map([["event-a", eventScope()], ["event-b", eventScope("event-b", "org-b")], ["event-a2", eventScope("event-a2", "org-a")]]);
  const grants = new Map<string, Set<EventStaffCapability>>();
  const grant = (userId: string, eventId: string, ...capabilities: EventStaffCapability[]) => grants.set(`${userId}:${eventId}`, new Set(capabilities));
  for (const eventId of scopes.keys()) grant("staff", eventId, "registration_manage", "teams_manage");
  grant("team-staff", "event-a", "teams_manage");
  const events: HostedEventAccessPort = {
    async getEvent(sql, eventId) { if (!transactionExecutors.has(sql) && sql !== database) throw new Error("Unexpected executor."); return scopes.has(eventId) ? structuredClone(scopes.get(eventId)!) : null; },
    async requireStaff(_sql, actor, eventId, capability) {
      if (!grants.get(`${actor.userId}:${eventId}`)?.has(capability)) throw new DomainError("EVENT_ACCESS_DENIED", "当前工作人员权限不足。", { status: 403 });
      const event = scopes.get(eventId); if (!event) throw new DomainError("NOT_FOUND", "不存在。", { status: 404 }); return structuredClone(event);
    },
  };
  function principal(userId: string, beforeCheck?: (sql: SqlExecutor, invocation: number) => Promise<void>): OrganizerPrincipal {
    let invocation = 0;
    return { actor: { userId, platformRoles: ["user"] }, async guard(sql) {
      if (!transactionExecutors.has(sql)) throw new Error("Guard must use the operation transaction.");
      await beforeCheck?.(sql, ++invocation);
      const row = (await sql.query<{ active: boolean; session_active: boolean }>("SELECT active,session_active FROM auth_users WHERE id=$1", [userId])).rows[0];
      if (!row?.active || !row.session_active) throw new DomainError("UNAUTHENTICATED", "会话已失效。", { status: 401 });
    } };
  }
  const principals = Object.fromEntries(["alice", "bob", "carol", "dave", "staff", "team-staff", "manager"].map(id => [id, principal(id)]));
  let now = new Date(TEST_NOW), sequence = 0, confirmCalls = 0, previewCalls = 0;
  const managerCheck = async (sql: SqlExecutor, value: OrganizerPrincipal) => {
    await value.guard(sql);
    const row = (await sql.query<{ project_manager: boolean }>("SELECT project_manager FROM auth_users WHERE id=$1", [value.actor.userId])).rows[0];
    if (!row?.project_manager) throw new DomainError("PROJECT_ACCESS_DENIED", "仅当前私人项目管理员可以确认关联。", { status: 403 });
  };
  const projectLinks = { async confirmLink(sql: SqlExecutor, value: OrganizerPrincipal, input: { eventId: string; teamId: string; projectId: string; expectedProjectRevision: number }) {
    ++confirmCalls; await managerCheck(sql, value);
    if (input.expectedProjectRevision !== 7) throw new DomainError("VERSION_CONFLICT", "私人项目已变更。", { status: 409 });
    await sql.query("INSERT INTO fixture_root_links(event_id,team_id,project_id) VALUES($1,$2,$3) ON CONFLICT(event_id,team_id) DO NOTHING", [input.eventId, input.teamId, input.projectId]);
    await managerCheck(sql, value);
  } };
  const projectLinkPreview = { async requireManagerPreview(sql: SqlExecutor, value: OrganizerPrincipal) { ++previewCalls; await managerCheck(sql, value); } };
  const service = createEventRegistrationService({ database, events, projectLinks, ...(options.preview ? { projectLinkPreview } : {}), clock: { now: () => new Date(now) }, ids: { next: () => `record-${String(++sequence).padStart(6, "0")}` } });
  async function publish(eventId = "event-a", fields = DEFAULT_FIELDS) {
    const form = (await service.getStaffForm(principals.staff, eventId)).form;
    return service.saveForm(principals.staff, eventId, { expectedRevision: form?.revision ?? 0, title: "报名参加", description: "请填写你的参赛意向", fields, changeNote: form ? "增加字段，请重新核对" : "" });
  }
  async function draft(userId: string, eventId = "event-a", answers: RegistrationAnswers = { goal: "做一个小作品" }) {
    const view = await service.getMine(principals[userId], eventId);
    return service.saveDraft(principals[userId], eventId, { expectedRevision: view.registration?.revision ?? 0, formRevision: view.form!.revision, answers });
  }
  async function register(userId: string, eventId = "event-a") {
    const value = await draft(userId, eventId);
    return service.submit(principals[userId], eventId, { expectedRevision: value.revision, idempotencyKey: `submit-${userId}-${eventId}-${value.revision}` });
  }
  async function createTeam(userId = "alice", eventId = "event-a") { return service.createTeam(principals[userId], eventId, { name: `${userId} 的队伍`, introduction: "一起做小作品", track: "", idempotencyKey: `team-${userId}-${eventId}` }); }
  async function addMember(teamId: string, userId: string, captain = "alice", eventId = "event-a") {
    const team = await service.getTeam(database, eventId, teamId);
    const request = await service.requestJoin(principals[userId], eventId, teamId, { expectedTeamRevision: team!.revision, message: "本人希望加入", idempotencyKey: `join-${teamId}-${userId}` });
    await service.respondJoin(principals[captain], eventId, teamId, request.id, { expectedRevision: request.revision, expectedTeamRevision: team!.revision, decision: "accepted", note: "", idempotencyKey: `accept-${request.id}` });
    return request;
  }
  return { engine, database, service, events, scopes, grants, grant, principal, principals, statements, publish, draft, register, createTeam, addMember,
    setNow: (value: string) => { now = new Date(value); }, get confirmCalls() { return confirmCalls; }, get previewCalls() { return previewCalls; } };
}
