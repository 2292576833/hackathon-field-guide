import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { JoinRequest, Page, ProjectLinkRequest, Registration, RegistrationForm, RosterTeam, TeamSuggestion } from "./model.ts";
import type { ListOptions, RegistrationRepository, RegistrationStore } from "./repository.ts";

type DataRow<T> = { data: T | string };
function decode<T>(row: DataRow<T> | undefined): T | null {
  return row ? typeof row.data === "string" ? JSON.parse(row.data) as T : structuredClone(row.data) : null;
}
function versionConflict(): never {
  throw new DomainError("VERSION_CONFLICT", "记录已更新，请先读取最新版本。", { status: 409, recoveryAction: "review_latest_version" });
}
function assertRevision(revision: number, previousRevision: number): void {
  if (!Number.isSafeInteger(previousRevision) || previousRevision < 0 || revision !== previousRevision + 1) {
    throw new DomainError("INVALID_INPUT", "保存记录必须使用连续版本。");
  }
}
function pageLimit(options: ListOptions): number {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new DomainError("INVALID_INPUT", "每页读取数量须为 1 至 100。");
  }
  return options.limit;
}
function page<T extends { id: string }>(rows: readonly DataRow<T>[], limit: number): Page<T> {
  const items = rows.slice(0, limit).map(row => decode(row)!);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}
function assertFingerprint(fingerprint: string): void {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new DomainError("INVALID_INPUT", "操作指纹必须为 SHA-256 摘要。");
}
function idempotencyConflict(): never {
  throw new DomainError("IDEMPOTENCY_CONFLICT", "同一操作标识对应的内容已变更，请核对后重新发起。", { status: 409 });
}

/** Uses the caller's guarded transaction; read methods never initialize records or acquire write locks. */
export class PostgresRegistrationStore implements RegistrationStore {
  readonly sql: SqlExecutor;
  constructor(sql: SqlExecutor) { this.sql = sql; }

  async lockEvent(eventId: string, organizationId: string): Promise<void> {
    await this.sql.query("INSERT INTO event_registration_event_state(event_id,organization_id) VALUES ($1,$2) ON CONFLICT(event_id) DO NOTHING", [eventId, organizationId]);
    const row = (await this.sql.query<{ organization_id: string }>("SELECT organization_id FROM event_registration_event_state WHERE event_id=$1 FOR UPDATE", [eventId])).rows[0];
    if (!row || row.organization_id !== organizationId) {
      throw new DomainError("EVENT_SCOPE_CONFLICT", "比赛所属组织与已保存记录不一致。", { status: 409 });
    }
  }

  async getForm(eventId: string): Promise<RegistrationForm | null> {
    return decode((await this.sql.query<DataRow<RegistrationForm>>("SELECT data FROM event_registration_forms WHERE event_id=$1 ORDER BY revision DESC LIMIT 1", [eventId])).rows[0]);
  }
  async appendForm(form: RegistrationForm): Promise<void> {
    if (!Number.isSafeInteger(form.revision) || form.revision < 1) throw new DomainError("INVALID_INPUT", "报名表版本无效。");
    const result = await this.sql.query("INSERT INTO event_registration_forms(event_id,revision,published_at,data) VALUES ($1,$2,$3::timestamptz,$4::jsonb) ON CONFLICT DO NOTHING RETURNING revision", [form.eventId, form.revision, form.publishedAt, JSON.stringify(form)]);
    if (result.rowCount !== 1) versionConflict();
  }

  async getRegistration(eventId: string, userId: string): Promise<Registration | null> {
    return decode((await this.sql.query<DataRow<Registration>>("SELECT data FROM event_registration_registrations WHERE event_id=$1 AND user_id=$2", [eventId, userId])).rows[0]);
  }
  async getRegistrationById(eventId: string, id: string): Promise<Registration | null> {
    return decode((await this.sql.query<DataRow<Registration>>("SELECT data FROM event_registration_registrations WHERE event_id=$1 AND id=$2", [eventId, id])).rows[0]);
  }
  async saveRegistration(value: Registration, previousRevision: number, actorUserId: string): Promise<void> {
    assertRevision(value.revision, previousRevision);
    const args = [value.eventId, value.id, value.organizationId, value.userId, value.revision, value.status, value.createdAt, value.updatedAt, JSON.stringify(value)];
    const result = previousRevision === 0
      ? await this.sql.query("INSERT INTO event_registration_registrations(event_id,id,organization_id,user_id,revision,status,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::jsonb) ON CONFLICT DO NOTHING RETURNING id", args)
      : await this.sql.query("UPDATE event_registration_registrations SET revision=$5,status=$6,updated_at=$8::timestamptz,data=$9::jsonb WHERE event_id=$1 AND id=$2 AND organization_id=$3 AND user_id=$4 AND created_at=$7::timestamptz AND revision=$10 RETURNING id", [...args, previousRevision]);
    if (result.rowCount !== 1) versionConflict();
    await this.history("registration", value, actorUserId);
  }
  async countReservations(eventId: string): Promise<number> {
    const row = (await this.sql.query<{ count: number | string }>("SELECT count(*) AS count FROM event_registration_registrations WHERE event_id=$1 AND status IN ('pending','approved')", [eventId])).rows[0];
    return Number(row?.count ?? 0);
  }
  async countRegistrations(eventId: string): Promise<Record<Registration["status"], number>> {
    const rows = (await this.sql.query<{ status: Registration["status"]; count: number | string }>(
      "SELECT status, count(*) AS count FROM event_registration_registrations WHERE event_id=$1 AND status<>'draft' AND data->>'submittedAt' IS NOT NULL GROUP BY status", [eventId])).rows;
    const counts: Record<Registration["status"], number> = { draft: 0, pending: 0, approved: 0, rejected: 0, withdrawn: 0 };
    for (const row of rows) if (row.status in counts) counts[row.status] = Number(row.count);
    counts.draft = 0; // 草稿只有本人可见，主办方视图不统计。
    return counts;
  }
  async listRegistrations(eventId: string, options: ListOptions): Promise<Page<Registration>> {
    const limit = pageLimit(options);
    const result = await this.sql.query<DataRow<Registration>>("SELECT data FROM event_registration_registrations WHERE event_id=$1 AND status<>'draft' AND data->>'submittedAt' IS NOT NULL AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR id>$3) ORDER BY id ASC LIMIT $4", [eventId, options.status ?? null, options.cursor ?? null, limit + 1]);
    return page(result.rows, limit);
  }
  async listOwnRegistrations(userId: string, options: ListOptions): Promise<Page<Registration>> {
    const limit = pageLimit(options);
    // This is the sole cross-event query: ownership is always constrained to the requesting account.
    const result = await this.sql.query<DataRow<Registration>>("SELECT data FROM event_registration_registrations WHERE user_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR id>$3) ORDER BY id ASC LIMIT $4", [userId, options.status ?? null, options.cursor ?? null, limit + 1]);
    return page(result.rows, limit);
  }

  async getTeam(eventId: string, id: string): Promise<RosterTeam | null> {
    return decode((await this.sql.query<DataRow<RosterTeam>>("SELECT data FROM event_registration_teams WHERE event_id=$1 AND id=$2", [eventId, id])).rows[0]);
  }
  async saveTeam(value: RosterTeam, previousRevision: number, actorUserId: string): Promise<void> {
    assertRevision(value.revision, previousRevision);
    const args = [value.eventId, value.id, value.organizationId, value.captainUserId, value.revision, value.status, value.createdAt, value.updatedAt, JSON.stringify(value)];
    const result = previousRevision === 0
      ? await this.sql.query("INSERT INTO event_registration_teams(event_id,id,organization_id,captain_user_id,revision,status,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::jsonb) ON CONFLICT DO NOTHING RETURNING id", args)
      : await this.sql.query("UPDATE event_registration_teams SET captain_user_id=$4,revision=$5,status=$6,updated_at=$8::timestamptz,data=$9::jsonb WHERE event_id=$1 AND id=$2 AND organization_id=$3 AND created_at=$7::timestamptz AND revision=$10 RETURNING id", [...args, previousRevision]);
    if (result.rowCount !== 1) versionConflict();
    await this.history("team", value, actorUserId);
  }
  async listTeams(eventId: string, options: ListOptions): Promise<Page<RosterTeam>> {
    const limit = pageLimit(options);
    const result = await this.sql.query<DataRow<RosterTeam>>("SELECT data FROM event_registration_teams WHERE event_id=$1 AND (($2::text IS NULL AND status IN ('forming','locked')) OR status=$2) AND ($3::text IS NULL OR id>$3) ORDER BY id ASC LIMIT $4", [eventId, options.status ?? null, options.cursor ?? null, limit + 1]);
    return page(result.rows, limit);
  }
  async activeTeamId(eventId: string, userId: string): Promise<string | null> {
    return (await this.sql.query<{ team_id: string }>("SELECT team_id FROM event_registration_members WHERE event_id=$1 AND user_id=$2 AND left_at IS NULL", [eventId, userId])).rows[0]?.team_id ?? null;
  }
  async memberIds(eventId: string, teamId: string): Promise<string[]> {
    return (await this.sql.query<{ user_id: string }>("SELECT user_id FROM event_registration_members WHERE event_id=$1 AND team_id=$2 AND left_at IS NULL ORDER BY user_id ASC", [eventId, teamId])).rows.map(row => row.user_id);
  }
  async acceptMember(eventId: string, teamId: string, userId: string, acceptedAt: string): Promise<void> {
    try {
      await this.sql.query("INSERT INTO event_registration_members(event_id,team_id,user_id,accepted_at,left_at) VALUES ($1,$2,$3,$4::timestamptz,NULL) ON CONFLICT(event_id,team_id,user_id) DO UPDATE SET accepted_at=EXCLUDED.accepted_at,left_at=NULL WHERE event_registration_members.left_at IS NOT NULL", [eventId, teamId, userId, acceptedAt]);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new DomainError("TEAM_MEMBERSHIP_CONFLICT", "你已加入本比赛的另一支队伍，请先退出原队伍。", { status: 409 });
      }
      throw error;
    }
  }
  async leaveMember(eventId: string, teamId: string, userId: string, leftAt: string): Promise<void> {
    await this.sql.query("UPDATE event_registration_members SET left_at=$4::timestamptz WHERE event_id=$1 AND team_id=$2 AND user_id=$3 AND left_at IS NULL", [eventId, teamId, userId, leftAt]);
  }

  async getJoin(eventId: string, teamId: string, id: string): Promise<JoinRequest | null> {
    return decode((await this.sql.query<DataRow<JoinRequest>>("SELECT data FROM event_registration_join_requests WHERE event_id=$1 AND team_id=$2 AND id=$3", [eventId, teamId, id])).rows[0]);
  }
  async getUserJoin(eventId: string, teamId: string, userId: string): Promise<JoinRequest | null> {
    return decode((await this.sql.query<DataRow<JoinRequest>>("SELECT data FROM event_registration_join_requests WHERE event_id=$1 AND team_id=$2 AND user_id=$3", [eventId, teamId, userId])).rows[0]);
  }
  async ownRequests(eventId: string, userId: string): Promise<JoinRequest[]> {
    return (await this.sql.query<DataRow<JoinRequest>>("SELECT data FROM event_registration_join_requests WHERE event_id=$1 AND user_id=$2 ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,updated_at DESC,id ASC LIMIT 100", [eventId, userId])).rows.map(row => decode(row)!);
  }
  async pendingRequests(eventId: string, teamId: string): Promise<JoinRequest[]> {
    return (await this.sql.query<DataRow<JoinRequest>>("SELECT data FROM event_registration_join_requests WHERE event_id=$1 AND team_id=$2 AND status='pending' ORDER BY id ASC LIMIT 100", [eventId, teamId])).rows.map(row => decode(row)!);
  }
  async saveJoin(value: JoinRequest, previousRevision: number, actorUserId: string): Promise<void> {
    assertRevision(value.revision, previousRevision);
    const args = [value.eventId, value.id, value.teamId, value.userId, value.revision, value.status, value.createdAt, value.updatedAt, JSON.stringify(value)];
    const result = previousRevision === 0
      ? await this.sql.query("INSERT INTO event_registration_join_requests(event_id,id,team_id,user_id,revision,status,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::jsonb) ON CONFLICT DO NOTHING RETURNING id", args)
      : await this.sql.query("UPDATE event_registration_join_requests SET revision=$5,status=$6,updated_at=$8::timestamptz,data=$9::jsonb WHERE event_id=$1 AND id=$2 AND team_id=$3 AND user_id=$4 AND created_at=$7::timestamptz AND revision=$10 RETURNING id", [...args, previousRevision]);
    if (result.rowCount !== 1) versionConflict();
    await this.history("join", value, actorUserId);
  }

  async getLink(eventId: string, teamId: string, id?: string): Promise<ProjectLinkRequest | null> {
    return decode((await this.sql.query<DataRow<ProjectLinkRequest>>("SELECT data FROM event_registration_project_links WHERE event_id=$1 AND team_id=$2 AND ($3::text IS NULL OR id=$3) ORDER BY CASE WHEN status='pending' THEN 0 WHEN status='confirmed' THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT 1", [eventId, teamId, id ?? null])).rows[0]);
  }
  async saveLink(value: ProjectLinkRequest, previousRevision: number, actorUserId: string): Promise<void> {
    assertRevision(value.revision, previousRevision);
    const args = [value.eventId, value.id, value.teamId, value.projectId, value.requestedByUserId, value.revision, value.status, value.createdAt, JSON.stringify(value)];
    const result = previousRevision === 0
      ? await this.sql.query("INSERT INTO event_registration_project_links(event_id,id,team_id,project_id,requested_by_user_id,revision,status,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb) ON CONFLICT DO NOTHING RETURNING id", args)
      : await this.sql.query("UPDATE event_registration_project_links SET revision=$6,status=$7,data=$9::jsonb WHERE event_id=$1 AND id=$2 AND team_id=$3 AND project_id=$4 AND requested_by_user_id=$5 AND created_at=$8::timestamptz AND revision=$10 RETURNING id", [...args, previousRevision]);
    if (result.rowCount !== 1) versionConflict();
    await this.history("link", value, actorUserId);
  }

  async getSuggestion(eventId: string, id: string): Promise<TeamSuggestion | null> {
    const row = (await this.sql.query<DataRow<TeamSuggestion> & { team_id: string | null }>("SELECT data,team_id FROM event_registration_team_suggestions WHERE event_id=$1 AND id=$2", [eventId, id])).rows[0];
    return row ? { ...decode(row)!, teamId: row.team_id } : null;
  }
  async listSuggestions(eventId: string, userId?: string): Promise<TeamSuggestion[]> {
    const rows = (await this.sql.query<DataRow<TeamSuggestion> & { team_id: string | null }>("SELECT data,team_id FROM event_registration_team_suggestions WHERE event_id=$1 AND ($2::text IS NULL OR (data->'memberUserIds') ? $2) ORDER BY id ASC LIMIT 100", [eventId, userId ?? null])).rows;
    return rows.map(row => ({ ...decode(row)!, teamId: row.team_id }));
  }
  async isSuggestedForTeam(eventId: string, teamId: string, userId: string): Promise<boolean> {
    return (await this.sql.query("SELECT id FROM event_registration_team_suggestions WHERE event_id=$1 AND team_id=$2 AND (data->'memberUserIds') ? $3 LIMIT 1", [eventId, teamId, userId])).rows.length > 0;
  }
  async saveSuggestion(value: TeamSuggestion): Promise<void> {
    // The initial proposal stays immutable; only its confirmed team reference may advance from null.
    const saved = await this.sql.query("INSERT INTO event_registration_team_suggestions(event_id,id,captain_user_id,created_by_user_id,team_id,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(event_id,id) DO UPDATE SET team_id=EXCLUDED.team_id WHERE event_registration_team_suggestions.data - 'teamId' = EXCLUDED.data - 'teamId' AND (event_registration_team_suggestions.team_id IS NULL OR event_registration_team_suggestions.team_id=EXCLUDED.team_id) RETURNING id", [value.eventId, value.id, value.captainUserId, value.createdByUserId, value.teamId, JSON.stringify(value)]);
    if (saved.rowCount !== 1) versionConflict();
  }

  async getReceipt<T>(eventId: string, userId: string, operation: string, key: string, fingerprint: string): Promise<T | null> {
    assertFingerprint(fingerprint);
    const row = (await this.sql.query<{ fingerprint: string; data: T | string }>("SELECT fingerprint,data FROM event_registration_receipts WHERE event_id=$1 AND user_id=$2 AND operation=$3 AND key=$4", [eventId, userId, operation, key])).rows[0];
    if (!row) return null;
    if (row.fingerprint !== fingerprint) idempotencyConflict();
    return decode(row);
  }
  async putReceipt(eventId: string, userId: string, operation: string, key: string, fingerprint: string, result: unknown): Promise<void> {
    assertFingerprint(fingerprint);
    const saved = await this.sql.query("INSERT INTO event_registration_receipts(event_id,user_id,operation,key,fingerprint,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING key", [eventId, userId, operation, key, fingerprint, JSON.stringify(result)]);
    if (saved.rowCount !== 1) await this.getReceipt(eventId, userId, operation, key, fingerprint);
  }
  private async history(kind: "registration" | "team" | "join" | "link", value: { eventId: string; id: string; revision: number }, actorUserId: string): Promise<void> {
    const saved = await this.sql.query("INSERT INTO event_registration_history(event_id,kind,id,revision,actor_user_id,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING revision", [value.eventId, kind, value.id, value.revision, actorUserId, JSON.stringify(value)]);
    if (saved.rowCount !== 1) versionConflict();
  }
}

/** Persistent factory: the root supplies its existing PostgreSQL/PGlite DatabasePort. */
export class PostgresRegistrationRepository implements RegistrationRepository {
  readonly database: DatabasePort;
  constructor(database: DatabasePort) { this.database = database; }
  store(sql: SqlExecutor): RegistrationStore { return new PostgresRegistrationStore(sql); }
}
