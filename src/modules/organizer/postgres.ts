import type { SqlExecutor } from "../../shared/persistence.ts";
import type { Organization, OrganizationApplication, StaffGrant, StaffInvitation, HostedEvent, PublishedEventRevision, PublicationChange, OrganizerClaimRequest, EventProfile, EventAssistantSwitch } from "./model.ts";

const decode = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
async function first<T>(sql: SqlExecutor, statement: string, parameters: readonly unknown[]): Promise<T | null> {
  const result = await sql.query<{ document: unknown }>(statement, parameters);
  return result.rows[0] ? decode<T>(result.rows[0].document) : null;
}
async function many<T>(sql: SqlExecutor, statement: string, parameters: readonly unknown[] = []): Promise<T[]> {
  const result = await sql.query<{ document: unknown }>(statement, parameters);
  return result.rows.map(row => decode<T>(row.document));
}
/** Stateless adapter. All calls use the caller's transaction, no private DB or memory fallback. */
export class PostgresOrganizerRepository {
  getOrganization(sql: SqlExecutor, id: string, lock = false) { return first<Organization>(sql, `SELECT document FROM organizer_organizations WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]); }
  getApplication(sql: SqlExecutor, id: string) { return first<OrganizationApplication>(sql, "SELECT document FROM organizer_applications WHERE id=$1", [id]); }
  listApplications(sql: SqlExecutor, userId?: string) { return many<OrganizationApplication>(sql, `SELECT document FROM organizer_applications${userId ? " WHERE applicant_user_id=$1" : ""} ORDER BY id`, userId ? [userId] : []); }
  getEvent(sql: SqlExecutor, id: string, lock = false) { return first<HostedEvent>(sql, `SELECT document FROM organizer_hosted_events WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]); }
  listEvents(sql: SqlExecutor, organizationId?: string) { return many<HostedEvent>(sql, `SELECT document FROM organizer_hosted_events${organizationId ? " WHERE organization_id=$1" : ""} ORDER BY id`, organizationId ? [organizationId] : []); }
  getGrant(sql: SqlExecutor, id: string) { return first<StaffGrant>(sql, "SELECT document FROM organizer_staff_grants WHERE id=$1", [id]); }
  listGrants(sql: SqlExecutor, organizationId: string, userId?: string) { return many<StaffGrant>(sql, `SELECT document FROM organizer_staff_grants WHERE organization_id=$1${userId ? " AND user_id=$2" : ""} ORDER BY id`, userId ? [organizationId, userId] : [organizationId]); }
  listUserGrants(sql: SqlExecutor, userId: string) { return many<StaffGrant>(sql, "SELECT document FROM organizer_staff_grants WHERE user_id=$1 AND status='active' ORDER BY organization_id,id", [userId]); }
  getPublication(sql: SqlExecutor, eventId: string, version: number) { return first<PublishedEventRevision>(sql, "SELECT document FROM organizer_event_publications WHERE event_id=$1 AND version=$2", [eventId, version]); }
  listPublications(sql: SqlExecutor, eventId: string) { return many<PublishedEventRevision>(sql, "SELECT document FROM organizer_event_publications WHERE event_id=$1 ORDER BY version DESC", [eventId]); }
  listChanges(sql: SqlExecutor, eventId: string) { return many<PublicationChange>(sql, "SELECT document FROM organizer_publication_changes WHERE event_id=$1 ORDER BY version DESC", [eventId]); }
  async insertOrganization(sql: SqlExecutor, value: Organization) { await sql.query("INSERT INTO organizer_organizations(id,owner_user_id,status,revision,document) VALUES($1,$2,$3,$4,$5::jsonb)", [value.id,value.ownerUserId,value.status,value.revision,JSON.stringify(value)]); }
  async saveOrganization(sql: SqlExecutor, value: Organization) { await sql.query("UPDATE organizer_organizations SET status=$2,revision=$3,document=$4::jsonb WHERE id=$1", [value.id,value.status,value.revision,JSON.stringify(value)]); }
  async insertApplication(sql: SqlExecutor, value: OrganizationApplication) { await sql.query("INSERT INTO organizer_applications(id,organization_id,applicant_user_id,status,revision,document) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [value.id,value.organizationId,value.applicantUserId,value.status,value.revision,JSON.stringify(value)]); }
  async saveApplication(sql: SqlExecutor, value: OrganizationApplication) { await sql.query("UPDATE organizer_applications SET status=$2,revision=$3,document=$4::jsonb WHERE id=$1", [value.id,value.status,value.revision,JSON.stringify(value)]); }
  async insertEvent(sql: SqlExecutor, value: HostedEvent) { await sql.query("INSERT INTO organizer_hosted_events(id,organization_id,status,revision,published_revision,document) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [value.eventId,value.organizationId,value.status,value.revision,value.publishedRevision,JSON.stringify(value)]); }
  async saveEvent(sql: SqlExecutor, value: HostedEvent) { await sql.query("UPDATE organizer_hosted_events SET status=$2,revision=$3,published_revision=$4,document=$5::jsonb WHERE id=$1", [value.eventId,value.status,value.revision,value.publishedRevision,JSON.stringify(value)]); }
  async insertGrant(sql: SqlExecutor, value: StaffGrant) { await sql.query("INSERT INTO organizer_staff_grants(id,organization_id,event_id,user_id,role,capabilities,status,revision,document) VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9::jsonb)", [value.id,value.organizationId,value.eventId,value.userId,value.role,[...value.capabilities],value.status,value.revision,JSON.stringify(value)]); }
  async saveGrant(sql: SqlExecutor, value: StaffGrant) { await sql.query("UPDATE organizer_staff_grants SET status=$2,revision=$3,document=$4::jsonb WHERE id=$1", [value.id,value.status,value.revision,JSON.stringify(value)]); }
  async insertPublication(sql: SqlExecutor, value: PublishedEventRevision) { await sql.query("INSERT INTO organizer_event_publications(event_id,version,source_revision,document) VALUES($1,$2,$3,$4::jsonb)", [value.eventId,value.version,value.sourceRevision,JSON.stringify(value)]); }
  async insertChange(sql: SqlExecutor, value: PublicationChange) { await sql.query("INSERT INTO organizer_publication_changes(id,organization_id,event_id,version,document) VALUES($1,$2,$3,$4,$5::jsonb)", [value.id,value.organizationId,value.eventId,value.version,JSON.stringify(value)]); }
  async audit(sql: SqlExecutor, value: { id: string; organizationId: string; eventId?: string; actorUserId: string; action: string; entityId: string; revision: number; createdAt: string }) {
    await sql.query("INSERT INTO organizer_audit_events(id,organization_id,event_id,actor_user_id,action,entity_id,revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [value.id,value.organizationId,value.eventId ?? null,value.actorUserId,value.action,value.entityId,value.revision,value.createdAt]);
  }
  getClaim(sql: SqlExecutor, id: string, lock = false) { return first<OrganizerClaimRequest>(sql, `SELECT document FROM organizer_claim_requests WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]); }
  listClaims(sql: SqlExecutor, organizationId?: string, status?: string) {
    const conditions: string[] = [], parameters: unknown[] = [];
    if (organizationId) { parameters.push(organizationId); conditions.push(`organization_id=$${parameters.length}`); }
    if (status) { parameters.push(status); conditions.push(`status=$${parameters.length}`); }
    return many<OrganizerClaimRequest>(sql, `SELECT document FROM organizer_claim_requests${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC, id`, parameters);
  }
  /** 该发现当前是否已被占用（pending 或 approved）；用于认领前的可认领判断。 */
  async activeClaimFor(sql: SqlExecutor, discoveryId: string) {
    return first<OrganizerClaimRequest>(sql, "SELECT document FROM organizer_claim_requests WHERE discovery_id=$1 AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1", [discoveryId]);
  }
  async insertClaim(sql: SqlExecutor, value: OrganizerClaimRequest) {
    await sql.query("INSERT INTO organizer_claim_requests(id,organization_id,discovery_id,source_host,requested_by,status,hosted_event_id,revision,document,created_at,updated_at,reviewed_by,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)",
      [value.id,value.organizationId,value.discoveryId,value.sourceHost,value.requestedBy,value.status,value.hostedEventId,value.revision,JSON.stringify(value),value.createdAt,value.updatedAt,value.reviewedBy,value.reviewedAt]);
  }
  async saveClaim(sql: SqlExecutor, value: OrganizerClaimRequest) {
    await sql.query("UPDATE organizer_claim_requests SET status=$2,hosted_event_id=$3,revision=$4,document=$5::jsonb,updated_at=$6,reviewed_by=$7,reviewed_at=$8 WHERE id=$1",
      [value.id,value.status,value.hostedEventId,value.revision,JSON.stringify(value),value.updatedAt,value.reviewedBy,value.reviewedAt]);
  }
  getEventProfile(sql: SqlExecutor, eventId: string, lock = false) { return first<EventProfile>(sql, `SELECT document FROM organizer_event_profiles WHERE event_id=$1${lock ? " FOR UPDATE" : ""}`, [eventId]); }
  /** 该赛事被哪个机构认领过（含待审核）；用于把发现卡片当只读证据来源。 */
  claimForEvent(sql: SqlExecutor, eventId: string) { return first<OrganizerClaimRequest>(sql, "SELECT document FROM organizer_claim_requests WHERE hosted_event_id=$1 ORDER BY created_at DESC LIMIT 1", [eventId]); }
  async insertEventProfile(sql: SqlExecutor, value: EventProfile) {
    await sql.query("INSERT INTO organizer_event_profiles(event_id,organization_id,revision,document,updated_by,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)",
      [value.eventId,value.organizationId,value.revision,JSON.stringify(value),value.updatedBy,value.updatedAt]);
  }
  async saveEventProfile(sql: SqlExecutor, value: EventProfile) {
    await sql.query("UPDATE organizer_event_profiles SET revision=$2,document=$3::jsonb,updated_by=$4,updated_at=$5 WHERE event_id=$1",
      [value.eventId,value.revision,JSON.stringify(value),value.updatedBy,value.updatedAt]);
  }
  /** P4：本场全部助手开关行（服务按根传入的 key 顺序重排，不依赖这里的排序）。 */
  listAssistantSwitches(sql: SqlExecutor, eventId: string) { return many<EventAssistantSwitch>(sql, "SELECT document FROM organizer_event_assistant_switches WHERE event_id=$1 ORDER BY assistant_key", [eventId]); }
  /** P4：单个助手开关；`lock` 用于同一键并发写入的互斥。 */
  getAssistantSwitch(sql: SqlExecutor, eventId: string, assistantKey: string, lock = false) {
    return first<EventAssistantSwitch>(sql, `SELECT document FROM organizer_event_assistant_switches WHERE event_id=$1 AND assistant_key=$2${lock ? " FOR UPDATE" : ""}`, [eventId, assistantKey]);
  }
  async insertAssistantSwitch(sql: SqlExecutor, value: EventAssistantSwitch) {
    await sql.query("INSERT INTO organizer_event_assistant_switches(event_id,organization_id,assistant_key,enabled,revision,updated_by_user_id,updated_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
      [value.eventId,value.organizationId,value.assistantKey,value.enabled,value.revision,value.updatedByUserId,value.updatedAt,JSON.stringify(value)]);
  }
  async saveAssistantSwitch(sql: SqlExecutor, value: EventAssistantSwitch) {
    await sql.query("UPDATE organizer_event_assistant_switches SET enabled=$3,revision=$4,updated_by_user_id=$5,updated_at=$6,document=$7::jsonb WHERE event_id=$1 AND assistant_key=$2",
      [value.eventId,value.assistantKey,value.enabled,value.revision,value.updatedByUserId,value.updatedAt,JSON.stringify(value)]);
  }
  /** P3：按 token_hash 取邀请；`lock` 用于单次领取的并发互斥与"领取/撤销"同序加锁。 */
  getInvitationByTokenHash(sql: SqlExecutor, tokenHash: string, lock = false) { return first<StaffInvitation>(sql, `SELECT document FROM organizer_staff_invitations WHERE token_hash=$1${lock ? " FOR UPDATE" : ""}`, [tokenHash]); }
  getInvitation(sql: SqlExecutor, id: string, lock = false) { return first<StaffInvitation>(sql, `SELECT document FROM organizer_staff_invitations WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]); }
  listInvitations(sql: SqlExecutor, organizationId: string) { return many<StaffInvitation>(sql, "SELECT document FROM organizer_staff_invitations WHERE organization_id=$1 ORDER BY created_at DESC, id", [organizationId]); }
  async insertInvitation(sql: SqlExecutor, value: StaffInvitation) {
    await sql.query("INSERT INTO organizer_staff_invitations(id,organization_id,event_id,role,capabilities,status,token_hash,bound_email,expires_at,claimed_by_user_id,claimed_at,revoked_by_user_id,revoked_at,created_by_user_id,created_at,revision,document) VALUES($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)",
      [value.id,value.organizationId,value.eventId,value.role,[...value.capabilities],value.status,value.tokenHash,value.boundEmail,value.expiresAt,value.claimedByUserId,value.claimedAt,value.revokedByUserId,value.revokedAt,value.createdByUserId,value.createdAt,value.revision,JSON.stringify(value)]);
  }
  async saveInvitation(sql: SqlExecutor, value: StaffInvitation) {
    await sql.query("UPDATE organizer_staff_invitations SET status=$2,token_hash=$3,bound_email=$4,expires_at=$5,claimed_by_user_id=$6,claimed_at=$7,revoked_by_user_id=$8,revoked_at=$9,revision=$10,document=$11::jsonb WHERE id=$1",
      [value.id,value.status,value.tokenHash,value.boundEmail,value.expiresAt,value.claimedByUserId,value.claimedAt,value.revokedByUserId,value.revokedAt,value.revision,JSON.stringify(value)]);
  }
}
