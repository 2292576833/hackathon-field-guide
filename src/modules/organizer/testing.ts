import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor, PlatformRole } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { DEFAULT_EVENT_COMMUNITY } from "../../shared/organizer-contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EventConfigurationInput, HostedEvent } from "./model.ts";
import { createOrganizerService } from "./service.ts";
import type { OrganizerAccountEmailPort, OrganizerClaimDiscoveryPort, OrganizerJudgingConfigPort, OrganizerReadinessEvidencePort, OrganizerRegistrationFormPort } from "./service.ts";

export const organizerError = (code: string) => (failure: unknown): boolean => failure instanceof DomainError && failure.code === code;
export const TEST_USERS = {
  ownerA: ["user"], ownerB: ["user"], staff: ["user"], outsider: ["user"],
  administrator: ["user", "admin"], reviewer: ["user", "reviewer"],
} as const;
/** 夹具账号邮箱：默认都视为"已登录且邮箱已验证"，与根真实 Port 的契约一致。 */
export const TEST_EMAILS: Record<keyof typeof TEST_USERS, string> = {
  ownerA: "owner-a@example.test", ownerB: "owner-b@example.test", staff: "staff@example.test",
  outsider: "outsider@example.test", administrator: "administrator@example.test", reviewer: "reviewer@example.test",
};
/** 内存邮箱 Port：`overrides` 里给 null 表示该账号未验证/未激活；只记录调用，不写任何表。 */
export function accountEmailPort(overrides: Record<string,string|null> = {}) {
  const calls: string[] = [];
  const port: OrganizerAccountEmailPort = { async readVerifiedEmail(_sql, userId) {
    calls.push(userId);
    const email = Object.hasOwn(overrides,userId) ? overrides[userId] : TEST_EMAILS[userId as keyof typeof TEST_USERS] ?? null;
    return email ? { email: email.toLowerCase() } : null;
  } };
  return { port, calls };
}

export interface OrganizerFixtureOptions {
  readonly discovery?: OrganizerClaimDiscoveryPort;
  readonly readinessEvidence?: OrganizerReadinessEvidencePort;
  /** P05：由测试桩实现，用来验证复制编排（真实适配由根注入，见交付文档 NEEDS_INTERFACE）。 */
  readonly registrationForms?: OrganizerRegistrationFormPort;
  readonly judgingConfig?: OrganizerJudgingConfigPort;
  /** P3：领取时的账号邮箱事实。缺省=夹具里所有账号都已验证；显式传 `null`=模拟根未接入（领取失败关闭）。 */
  readonly accountEmails?: OrganizerAccountEmailPort | null;
  /**
   * P4：本场支持的模块助手 key（模拟根从 `module-assistants` 注册表传入）。
   * 缺省=未注入，用于验证"未接入时列表为空、写入 503"。夹具**不硬编码** 7 个生产 key。
   */
  readonly assistantKeys?: readonly string[];
}

/** Isolated PostgreSQL fixture only: no .env, filesystem database, workers or external services. */
export async function organizerFixture(t: TestContext, options: OrganizerFixtureOptions = {}) {
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  await engine.exec(`
    CREATE TABLE auth_users (id text PRIMARY KEY, active boolean NOT NULL, platform_roles text[] NOT NULL);
    CREATE TABLE organizer_test_sessions (id text PRIMARY KEY, user_id text NOT NULL REFERENCES auth_users(id), active boolean NOT NULL);
    CREATE TABLE event_discovery_cards (id text PRIMARY KEY);
  `);
  await engine.exec(await readFile(new URL("./migrations/001_organizer.sql", import.meta.url), "utf8"));
  await engine.exec(await readFile(new URL("../../../migrations/057_organizer_claim_requests.sql", import.meta.url), "utf8"));
  await engine.exec(await readFile(new URL("../../../migrations/058_organizer_event_profiles.sql", import.meta.url), "utf8"));
  await engine.exec(await readFile(new URL("./migrations/002-staff-invitations.sql", import.meta.url), "utf8"));
  await engine.exec(await readFile(new URL("./migrations/003-assistant-switches.sql", import.meta.url), "utf8"));
  const executor = (query: (statement: string, parameters: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const result = await query(statement, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  const direct = executor((statement, parameters) => engine.query(statement, parameters));
  const statements: string[] = [];
  const recording = (sql: SqlExecutor): SqlExecutor => ({
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      statements.push(statement); return sql.query<Row>(statement, parameters);
    },
  });
  const database: DatabasePort = {
    query: recording(direct).query,
    transaction: work => engine.transaction(tx => work(recording(executor((statement, parameters) => tx.query(statement, parameters))))),
  };
  for (const [userId, roles] of Object.entries(TEST_USERS)) {
    await direct.query("INSERT INTO auth_users VALUES($1,true,$2::text[])", [userId, [...roles]]);
    await direct.query("INSERT INTO organizer_test_sessions VALUES($1,$2,true)", [`session-${userId}`, userId]);
  }
  let id = 0, now = new Date("2026-10-11T04:00:00.000Z");
  const service = createOrganizerService({ database, clock: { now: () => new Date(now.getTime()) }, ids: { next: () => `organizer-test-${++id}` }, ...(options.accountEmails === null ? {} : { accountEmails: options.accountEmails ?? accountEmailPort().port }), ...(options.discovery ? { discovery: options.discovery } : {}), ...(options.readinessEvidence ? { readinessEvidence: options.readinessEvidence } : {}), ...(options.registrationForms ? { registrationForms: options.registrationForms } : {}), ...(options.judgingConfig ? { judgingConfig: options.judgingConfig } : {}), ...(options.assistantKeys ? { assistantKeys: options.assistantKeys } : {}) });
  const guardCalls = new Map<string, number>();
  function principal(userId: keyof typeof TEST_USERS, options: { readonly failAt?: number; readonly actor?: Actor } = {}): OrganizerPrincipal {
    let calls = 0;
    const actor: Actor = options.actor ?? { userId, platformRoles: [...TEST_USERS[userId]] as PlatformRole[] };
    return { actor, async guard(sql) {
      calls += 1; guardCalls.set(userId, (guardCalls.get(userId) ?? 0) + 1);
      const result = await sql.query<{ user_id: string; active: boolean; session_active: boolean; platform_roles: string[] }>(
        "SELECT u.id AS user_id,u.active,u.platform_roles,s.active AS session_active FROM auth_users u JOIN organizer_test_sessions s ON s.user_id=u.id WHERE s.id=$1",
        [`session-${userId}`],
      );
      const current = result.rows[0];
      if (options.failAt === calls || !current?.active || !current.session_active || current.user_id !== actor.userId
        || JSON.stringify([...current.platform_roles].sort()) !== JSON.stringify([...actor.platformRoles].sort())) {
        throw new DomainError("AUTH_SESSION_INVALID", "当前账号或请求会话已失效。", { status: 401 });
      }
    } };
  }
  const users = Object.fromEntries(Object.keys(TEST_USERS).map(id => [id, principal(id as keyof typeof TEST_USERS)])) as Record<keyof typeof TEST_USERS, OrganizerPrincipal>;
  async function counts() {
    const names = ["organizer_organizations", "organizer_applications", "organizer_staff_grants", "organizer_hosted_events", "organizer_event_publications", "organizer_publication_changes", "organizer_audit_events", "organizer_claim_requests", "organizer_event_profiles", "organizer_staff_invitations", "organizer_event_assistant_switches"];
    return Object.fromEntries(await Promise.all(names.map(async name => [name, (await direct.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${name}`)).rows[0]!.count])));
  }
  async function approvedOrganization(userId: "ownerA" | "ownerB" = "ownerA", name = userId === "ownerA" ? "测试机构甲" : "测试机构乙") {
    const application = await service.createApplication(users[userId], applicationInput(name));
    const reviewed = await service.reviewApplication(users.administrator, application.id, { expectedRevision: application.revision, decision: "approved", note: "人工核查测试依据" });
    const organization = (await service.listOrganizations(users[userId])).find(value => value.id === reviewed.organizationId)!;
    return { application: reviewed, organization, principal: users[userId] };
  }
  async function createEvent(organizationId: string, owner: OrganizerPrincipal, title = "测试线上赛", overrides: Partial<EventConfigurationInput> = {}) {
    const organization = (await service.listOrganizations(owner)).find(value => value.id === organizationId)!;
    return service.createEvent(owner, organizationId, { ...eventConfiguration(title), ...overrides, templateKey: "online", expectedOrganizationRevision: organization.revision });
  }
  async function publish(event: HostedEvent, owner: OrganizerPrincipal) {
    return service.publishEvent(owner, event.eventId, { expectedRevision: event.revision, changeSummary: "首次正式发布，请核对规则和期限" });
  }
  /** 认领外键指向自动发现表；测试按需种入线索 ID，不伪造卡片正文。 */
  async function seedDiscoveries(ids: readonly string[]) {
    for (const id of ids) await direct.query("INSERT INTO event_discovery_cards(id) VALUES($1) ON CONFLICT DO NOTHING", [id]);
  }
  /** 让邀请的"有效期/过期"可在测试里真实推进，不改任何生产默认。 */
  function setNow(value: string | Date) { now = value instanceof Date ? new Date(value.getTime()) : new Date(value); }
  function advanceDays(days: number) { now = new Date(now.getTime() + days * 86_400_000); }
  return { engine, database, direct, statements, service, users, principal, guardCalls, counts, approvedOrganization, createEvent, publish, seedDiscoveries, setNow, advanceDays, now: () => new Date(now.getTime()) };
}
export type OrganizerTestFixture = Awaited<ReturnType<typeof organizerFixture>>;

export function applicationInput(name = "测试社区") {
  return { name, kind: "community" as const, description: "公开活动组织", contactName: "私人联系人", contactEmail: "private-contact@organizer.org", evidenceText: "PRIVATE_EVIDENCE_TEXT", evidenceUrls: ["https://organizer.org/evidence"] };
}
export function eventConfiguration(title = "测试线上赛"): EventConfigurationInput {
  return {
    title, timezone: "Asia/Shanghai", startsAt: "2026-10-20T02:00:00.000Z", endsAt: "2026-10-22T10:00:00.000Z",
    registrationOpensAt: "2026-10-12T02:00:00.000Z", registrationClosesAt: "2026-10-19T10:00:00.000Z", submissionClosesAt: "2026-10-22T09:00:00.000Z",
    modules: { registration: true, teams: true, icebreaking: false, judging: true, schedule: true, accommodation: false, mealVouchers: false },
    registration: { reviewRequired: false, capacity: 30 }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null },
    community: { ...DEFAULT_EVENT_COMMUNITY },
    summary: "真实参与规则测试", rules: "由工作人员确认的公开规则", location: "在线参赛入口待官方通知",
  };
}
export function configurationOf(event: HostedEvent): EventConfigurationInput {
  const { title, timezone, startsAt, endsAt, registrationOpensAt, registrationClosesAt, submissionClosesAt, modules, registration, teams, community, summary, rules, location } = event;
  return structuredClone({ title, timezone, startsAt, endsAt, registrationOpensAt, registrationClosesAt, submissionClosesAt, modules, registration, teams, community: community ?? DEFAULT_EVENT_COMMUNITY, summary, rules, location });
}
