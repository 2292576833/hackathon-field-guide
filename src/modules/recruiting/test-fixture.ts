import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { ParticipantProfile } from "../../shared/participant.ts";
import type { FreshSessionGuard, PersonalAiPort, PersonalArtifact, PersonalGenerationRequest } from "../../shared/personal-ai.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { AvatarUpload, CardDraft, RecruitingPostData, RecruitingProfileData } from "./model.ts";
import type { RecruitingIdentityPort, RecruitingParticipantPort, RecruitingProjectsPort, RecruitingProjectState } from "./ports.ts";

export const testNow = "2026-10-09T12:00:00.000Z";
export const alice: Actor = { userId: "recruiting-alice", platformRoles: ["user"] };
export const bob: Actor = { userId: "recruiting-bob", platformRoles: ["admin"] };
export const manager: Actor = { userId: "recruiting-manager", platformRoles: ["user"] };
export const outsider: Actor = { userId: "recruiting-outsider", platformRoles: ["user"] };
export const projectId = "recruiting-space";

export function profileData(overrides: Partial<RecruitingProfileData> = {}): RecruitingProfileData {
  return { primaryRoles: ["frontend"], supportingRoles: ["design"], purposes: ["learn", "build"], purposeNote: "一起做出可演示作品", resume: "私人经历，仅本人默认可见。", workLinks: [{ title: "作品", url: "https://example.test/work" }], mbti: "INTP", age: 23, ...overrides };
}
export function cardDraft(overrides: Partial<CardDraft> = {}): CardDraft {
  return { headline: "愿意负责前端的小伙伴", introduction: "希望一起完成新人参赛助手。", primaryRoles: ["frontend"], supportingRoles: ["design"], purposes: ["learn", "build"], purposeNote: "", skills: ["TypeScript"], city: "上海", availableHoursPerDay: 2, workLinks: [{ title: "公开作品", url: "https://example.test/public-work" }], showMbti: false, showAge: false, showAvatar: false, ...overrides };
}
export function postData(overrides: Partial<RecruitingPostData> = {}): RecruitingPostData {
  return { spaceName: "新人参赛助手", title: "寻找前端伙伴", description: "本人明确填写的公开招募说明", neededRoles: ["frontend"], purposes: ["learn", "build"], seats: 2, status: "open", ...overrides };
}
export const pngAvatar: AvatarUpload = { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==" };
/** A genuine 1px white JPEG encoded by System.Drawing for a deterministic raster fixture. */
export const jpegAvatar: AvatarUpload = { mimeType: "image/jpeg", base64: "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==" };
export const webpAvatar: AvatarUpload = { mimeType: "image/webp", base64: "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vwEoAA=" };
export const corruptedPngAvatar: AvatarUpload = { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR3sAAAAASUVORK5CYII=" };
export const errorCode = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;
export const errorStatus = (status: number) => (error: unknown): boolean => error instanceof DomainError && error.status === status;

function participant(userId: string): ParticipantProfile {
  return { userId, revision: 1, firstHackathon: true, developmentExperience: "beginner", city: "上海", skills: ["TypeScript"], interests: ["教育"], projectIdea: "私人选题", availableHoursPerDay: 2, travelPreference: "local", presentationExperience: "none", updatedAt: testNow };
}

/** Every invocation owns an independent, memory-only PGlite; no production directory or external service is opened. */
export async function recruitingFixture() {
  const engine = new PGlite(); await engine.waitReady;
  await engine.exec(await readFile(new URL("./migrations/001_recruiting.sql", import.meta.url), "utf8"));
  await engine.exec(`
    CREATE TABLE fixture_identities(user_id text PRIMARY KEY, display_name text NOT NULL, active boolean NOT NULL DEFAULT true, session_active boolean NOT NULL DEFAULT true);
    CREATE TABLE fixture_participants(user_id text PRIMARY KEY, body jsonb NOT NULL);
    CREATE TABLE fixture_projects(project_id text PRIMARY KEY, archived boolean NOT NULL DEFAULT false);
    CREATE TABLE fixture_memberships(membership_id text PRIMARY KEY, project_id text NOT NULL, user_id text NOT NULL, role text NOT NULL, status text NOT NULL, UNIQUE(project_id,user_id));
    CREATE TABLE fixture_consumed_joins(application_id text PRIMARY KEY, membership_id text NOT NULL);
  `);
  for (const actor of [alice, bob, manager, outsider]) {
    await engine.query("INSERT INTO fixture_identities(user_id,display_name) VALUES($1,$2)", [actor.userId, actor.userId]);
    await engine.query("INSERT INTO fixture_participants(user_id,body) VALUES($1,$2::jsonb)", [actor.userId, JSON.stringify(participant(actor.userId))]);
  }
  await engine.query("INSERT INTO fixture_projects(project_id) VALUES($1)", [projectId]);
  await engine.query("INSERT INTO fixture_memberships(membership_id,project_id,user_id,role,status) VALUES('fixture-manager',$1,$2,'manager','active')", [projectId, manager.userId]);
  const activeTransactions = new Set<SqlExecutor>();
  function executor(query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor {
    return { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await query(statement, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
    } };
  }
  const database: DatabasePort = {
    ...executor((sql, parameters) => engine.query(sql, parameters)),
    transaction: work => engine.transaction(async transaction => {
      const sql = executor((statement, parameters) => transaction.query(statement, parameters));
      activeTransactions.add(sql); try { return await work(sql); } finally { activeTransactions.delete(sql); }
    }),
  };
  const identity: RecruitingIdentityPort = {
    async requireActive(sql, actor) {
      assert.ok(activeTransactions.has(sql), "identity must be checked through the service transaction");
      const result = await sql.query<{ display_name: string }>("SELECT display_name FROM fixture_identities WHERE user_id=$1 AND active FOR SHARE", [actor.userId]);
      const row = result.rows[0]; if (!row) throw new DomainError("UNAUTHENTICATED", "账号已失效。", { status: 401 });
      return { displayName: row.display_name };
    },
    async isActive(sql, userId) { return Boolean((await sql.query("SELECT user_id FROM fixture_identities WHERE user_id=$1 AND active FOR SHARE", [userId])).rowCount); },
  };
  const participants: RecruitingParticipantPort = {
    async readOwn(sql, actor) {
      assert.ok(activeTransactions.has(sql));
      const row = (await sql.query<{ body: ParticipantProfile }>("SELECT body FROM fixture_participants WHERE user_id=$1 FOR UPDATE", [actor.userId])).rows[0];
      assert.ok(row, "fixture participant exists"); return row.body;
    },
  };
  const state = { joinFailAfterWrite: false, duringGeneration: null as (() => Promise<void>) | null, aiOutput: null as unknown };
  const joins: { sql: SqlExecutor; input: Parameters<RecruitingProjectsPort["joinApproved"]>[1] }[] = [];
  let sequence = 0;
  const ids = { next: () => `recruiting-test-${++sequence}` };
  const projects: RecruitingProjectsPort = {
    async inspect(sql, requestedProjectId, userId) {
      assert.ok(activeTransactions.has(sql), "project inspection must share the transaction");
      const project = (await sql.query<{ archived: boolean }>("SELECT archived FROM fixture_projects WHERE project_id=$1 FOR UPDATE", [requestedProjectId])).rows[0];
      if (!project) return null;
      const membership = (await sql.query<{ membership_id: string; role: "manager" | "member"; status: "active" | "left" | "removed" }>("SELECT membership_id,role,status FROM fixture_memberships WHERE project_id=$1 AND user_id=$2 FOR SHARE", [requestedProjectId, userId])).rows[0];
      return { projectId: requestedProjectId, archived: project.archived, membership: membership ? { membershipId: membership.membership_id, role: membership.role, status: membership.status } : null } satisfies RecruitingProjectState;
    },
    async joinApproved(sql, input) {
      assert.ok(activeTransactions.has(sql), "join must use the supplied transaction rather than an independent commit");
      joins.push({ sql, input });
      await identity.requireActive(sql, input.actor);
      const approver = await projects.inspect(sql, input.projectId, input.approvedBy);
      if (!approver || approver.archived || approver.membership?.role !== "manager" || approver.membership.status !== "active") throw new DomainError("PROJECT_ACCESS_DENIED", "批准者已失去管理权。", { status: 403 });
      const existing = await projects.inspect(sql, input.projectId, input.actor.userId);
      if (existing?.membership) throw new DomainError("MEMBERSHIP_ALREADY_EXISTS", "加入事实已存在，不能重新激活。", { status: 409 });
      const membershipId = ids.next();
      await sql.query("INSERT INTO fixture_memberships(membership_id,project_id,user_id,role,status) VALUES($1,$2,$3,'member','active')", [membershipId, input.projectId, input.actor.userId]);
      await sql.query("INSERT INTO fixture_consumed_joins(application_id,membership_id) VALUES($1,$2)", [input.applicationId, membershipId]);
      if (state.joinFailAfterWrite) throw new Error("simulated member insert rollback");
      return { membershipId, role: "member", status: "active" };
    },
  };
  const generated: { actor: Actor; request: PersonalGenerationRequest<unknown> }[] = [];
  const artifacts = new Map<string, { userId: string; artifact: PersonalArtifact }>();
  const ai: PersonalAiPort = {
    async generate<T>(actor: Actor, request: PersonalGenerationRequest<T>, guard?: FreshSessionGuard): Promise<PersonalArtifact<T>> {
      generated.push({ actor, request });
      if (guard) await database.transaction(guard);
      if (state.duringGeneration) await state.duringGeneration();
      const data = request.validate(state.aiOutput ?? structuredClone(request.outputExample));
      if (guard) await database.transaction(guard);
      const artifact: PersonalArtifact<T> = { id: ids.next(), kind: request.kind, title: request.title, data, provider: "dsh", createdAt: testNow, sessionId: `fixture-ai-session-${actor.userId}` };
      artifacts.set(artifact.id, { userId: actor.userId, artifact: structuredClone(artifact) });
      return artifact;
    },
    async list(actor, kind, guard) {
      if (guard) await database.transaction(guard);
      return [...artifacts.values()].filter(row => row.userId === actor.userId && row.artifact.kind === kind).map(row => structuredClone(row.artifact));
    },
    async get(actor, id, guard) {
      if (guard) await database.transaction(guard);
      const row = artifacts.get(id); if (!row || row.userId !== actor.userId) throw new DomainError("ARTIFACT_NOT_FOUND", "私人报告不存在。", { status: 404 });
      return structuredClone(row.artifact);
    },
  };
  const guardFor = (actor: Actor): FreshSessionGuard => async sql => {
    assert.ok(activeTransactions.has(sql));
    if (!(await sql.query("SELECT user_id FROM fixture_identities WHERE user_id=$1 AND active AND session_active FOR SHARE", [actor.userId])).rowCount) throw new DomainError("UNAUTHENTICATED", "请求会话已失效。", { status: 401 });
  };
  async function reset() {
    await engine.exec("DELETE FROM recruiting_history; DELETE FROM recruiting_applications; DELETE FROM recruiting_posts; DELETE FROM recruiting_cards; DELETE FROM recruiting_profiles; DELETE FROM fixture_consumed_joins; DELETE FROM fixture_memberships WHERE membership_id<>'fixture-manager'; UPDATE fixture_memberships SET role='manager',status='active' WHERE membership_id='fixture-manager'; UPDATE fixture_projects SET archived=false; UPDATE fixture_identities SET active=true,session_active=true,display_name=user_id;");
    for (const actor of [alice, bob, manager, outsider]) await engine.query("UPDATE fixture_participants SET body=$2::jsonb WHERE user_id=$1", [actor.userId, JSON.stringify(participant(actor.userId))]);
    state.joinFailAfterWrite = false; state.duringGeneration = null; state.aiOutput = null; joins.length = 0; generated.length = 0; artifacts.clear();
  }
  return { engine, database, identity, participants, projects, ai, ids, clock: { now: () => new Date(testNow) }, state, joins, generated, artifacts, guardFor, activeTransactions, reset, close: () => engine.close() };
}
