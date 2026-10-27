import { DomainError } from "../../shared/errors.ts";
import type { HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { EventOfficialLinksOptions, EventOfficialLinksService, OfficialLinkStaleReason, OfficialRuleLink, OfficialRuleLinkView } from "./model.ts";
import * as v from "./validation.ts";

const staleMessages: Record<OfficialLinkStaleReason, string> = {
  hosted_unavailable: "比赛或主办方当前不可用，请先核对入驻与运营状态。",
  hosted_not_published: "比赛当前不是已发布状态，此关联暂时不能使用。",
  organization_changed: "比赛所属主办方与关联记录不一致，请重新核对。",
  hosted_version_changed: "主办方正式规则已更新，请核对后重新关联。",
  rules_unavailable: "关联的正式规则当前未发布或不可用。",
  rules_version_changed: "M03正式规则版本已更新，请核对后重新关联。",
};
function forbidden(): never { throw new DomainError("OFFICIAL_LINK_FORBIDDEN", "只有当前平台管理员可以管理正式规则关联。", { status: 403 }); }
function missing(): never { throw new DomainError("OFFICIAL_LINK_NOT_FOUND", "未找到当前可用的主办方比赛。", { status: 404 }); }
function conflict(actual: number): never { throw new DomainError("OFFICIAL_LINK_REVISION_CONFLICT", "关联已被更新，输入已保留。", { status: 409, latestRevision: actual, recoveryAction: "刷新当前关联，核对后重新提交。" }); }
function stale(): never { throw new DomainError("OFFICIAL_LINK_STALE_VERSION", "正式发布版本已变化，请重新核对后关联。", { status: 409, recoveryAction: "刷新比赛和正式规则的当前版本。" }); }
function checkPrincipal(principal: OrganizerPrincipal) {
  if (!principal?.actor?.userId || typeof principal.guard !== "function") throw new DomainError("UNAUTHENTICATED", "请登录后继续。", { status: 401 });
}
function sameHosted(a: HostedEventScope | null, b: HostedEventScope): boolean {
  return a !== null && a.eventId === b.eventId && a.organizationId === b.organizationId && a.status === "published" && a.publishedRevision === b.publishedRevision;
}

export function createEventOfficialLinksService(deps: EventOfficialLinksOptions): EventOfficialLinksService {
  async function admin<T>(principal: OrganizerPrincipal, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    checkPrincipal(principal);
    return deps.database.transaction(async sql => {
      await principal.guard(sql); if (!principal.actor.platformRoles.includes("admin")) forbidden();
      const result = await work(sql);
      await principal.guard(sql); if (!principal.actor.platformRoles.includes("admin")) forbidden();
      return result;
    });
  }
  async function head(sql: SqlExecutor, hostedEventId: string, lock: boolean | "share" = false) {
    const result = await sql.query<{ document: OfficialRuleLink }>(`SELECT document FROM event_official_links WHERE hosted_event_id=$1${lock === "share" ? " FOR SHARE" : lock ? " FOR UPDATE" : ""}`, [hostedEventId]);
    return result.rows[0]?.document ?? null;
  }
  async function inspect(sql: SqlExecutor, hosted: HostedEventScope | null, link: OfficialRuleLink | null, forUpdate = false): Promise<OfficialRuleLinkView> {
    const projection = hosted ? { eventId: hosted.eventId, organizationId: hosted.organizationId, organizationName: hosted.organizationName, title: hosted.title, status: hosted.status, publishedRevision: hosted.publishedRevision } : null;
    if (!link) return { hostedEvent: projection, link: null, state: "unlinked", staleReason: null, staleMessage: null, currentRules: null };
    if (link.status === "withdrawn") return { hostedEvent: projection, link, state: "withdrawn", staleReason: null, staleMessage: null, currentRules: null };
    const currentRules = v.published(await deps.rulesPort.getPublished(sql, link.linkedEventId, { forUpdate }), link.linkedEventId);
    let reason: OfficialLinkStaleReason | null = null;
    if (!hosted) reason = "hosted_unavailable";
    else if (hosted.status !== "published" || hosted.publishedRevision === null) reason = "hosted_not_published";
    else if (hosted.organizationId !== link.organizationId || hosted.eventId !== link.hostedEventId) reason = "organization_changed";
    else if (hosted.publishedRevision !== link.hostedPublishedRevision) reason = "hosted_version_changed";
    else if (!currentRules) reason = "rules_unavailable";
    else if (currentRules.publishedVersion !== link.rulesVersion) reason = "rules_version_changed";
    return { hostedEvent: projection, link, state: reason ? "stale" : "active", staleReason: reason, staleMessage: reason ? staleMessages[reason] : null, currentRules };
  }
  async function currentView(sql: SqlExecutor, hostedEventId: string) {
    const hosted = await deps.getHostedEvent(sql, hostedEventId), link = await head(sql, hostedEventId);
    if (!hosted && !link) missing();
    return inspect(sql, hosted, link);
  }
  async function writeHistory(sql: SqlExecutor, principal: OrganizerPrincipal, link: OfficialRuleLink, action: "set" | "withdraw") {
    await sql.query("INSERT INTO event_official_link_history(id,hosted_event_id,organization_id,revision,action,document,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [deps.ids.next(), link.hostedEventId, link.organizationId, link.revision, action, JSON.stringify(link), principal.actor.userId, link.updatedAt]);
  }
  return {
    get(principal, hostedEventId) { return admin(principal, sql => currentView(sql, v.id(hostedEventId))); },
    listCandidates(principal, hostedEventId, query = "") {
      return admin(principal, async sql => {
        const hosted = await deps.getHostedEvent(sql, v.id(hostedEventId)); if (!hosted) missing();
        if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) v.invalid("搜索词过长或无效。", 400);
        if (!deps.rulesPort.listPublished) throw new DomainError("OFFICIAL_RULE_CANDIDATES_UNCONFIGURED", "正式规则候选目录尚未接入，请联系平台管理员。", { status: 503 });
        const raw = await deps.rulesPort.listPublished(sql, { query: query.trim(), limit: 100 });
        const items = [], seen = new Set<string>();
        for (const value of raw.slice(0, 100)) {
          const candidate = v.published(value); if (!candidate || seen.has(candidate.eventId)) continue;
          // Do not trust a stale directory projection as current publication proof.
          const current = v.published(await deps.rulesPort.getPublished(sql, candidate.eventId), candidate.eventId);
          if (!current || current.publishedVersion !== candidate.publishedVersion) continue;
          seen.add(current.eventId); items.push(current);
        }
        const after = await deps.getHostedEvent(sql, hosted.eventId);
        if (!after || after.organizationId !== hosted.organizationId) missing();
        return items;
      });
    },
    set(principal, hostedEventId, input) {
      return admin(principal, async sql => {
        const id = v.id(hostedEventId), body = v.object(input, ["expectedRevision", "expectedHostedPublishedRevision", "linkedEventId", "rulesVersion", "auditNote"]);
        const expected = v.version(body.expectedRevision, true), expectedHosted = v.version(body.expectedHostedPublishedRevision), linkedEventId = v.id(body.linkedEventId), rulesVersion = v.version(body.rulesVersion), auditNote = v.text(body.auditNote);
        const hosted = await deps.getHostedEvent(sql, id, { forUpdate: true }); if (!hosted) missing();
        if (hosted.eventId !== id || hosted.status !== "published" || hosted.publishedRevision === null) stale();
        if (hosted.publishedRevision !== expectedHosted) stale();
        const old = await head(sql, id, true); if ((old?.revision ?? 0) !== expected) conflict(old?.revision ?? 0);
        if (old && old.organizationId !== hosted.organizationId) stale();
        const rules = v.published(await deps.rulesPort.getPublished(sql, linkedEventId, { forUpdate: true }), linkedEventId);
        if (!rules || rules.publishedVersion !== rulesVersion) stale();
        const link: OfficialRuleLink = { hostedEventId: id, organizationId: hosted.organizationId, hostedPublishedRevision: hosted.publishedRevision, linkedEventId, rulesVersion, rulesTitle: rules.title, rulesSourceUrl: rules.sourceUrl ?? null, revision: (old?.revision ?? 0) + 1, status: "active", auditNote, updatedBy: principal.actor.userId, updatedAt: deps.clock.now().toISOString() };
        if (old) {
          const changed = await sql.query("UPDATE event_official_links SET hosted_published_revision=$1,linked_event_id=$2,rules_version=$3,revision=$4,status='active',document=$5,updated_by=$6,updated_at=$7 WHERE hosted_event_id=$8 AND organization_id=$9 AND revision=$10", [link.hostedPublishedRevision, linkedEventId, rulesVersion, link.revision, JSON.stringify(link), link.updatedBy, link.updatedAt, id, hosted.organizationId, expected]);
          if (changed.rowCount !== 1) conflict((await head(sql, id))?.revision ?? 0);
        } else {
          const inserted = await sql.query("INSERT INTO event_official_links(hosted_event_id,organization_id,hosted_published_revision,linked_event_id,rules_version,revision,status,document,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,1,'active',$6,$7,$8) ON CONFLICT (hosted_event_id) DO NOTHING", [id, hosted.organizationId, hosted.publishedRevision, linkedEventId, rulesVersion, JSON.stringify(link), link.updatedBy, link.updatedAt]);
          if (inserted.rowCount !== 1) conflict((await head(sql, id))?.revision ?? 0);
        }
        await writeHistory(sql, principal, link, "set");
        const after = await deps.getHostedEvent(sql, id, { forUpdate: true }); if (!sameHosted(after, hosted)) stale();
        const view = await inspect(sql, after, link, true); if (view.state !== "active") stale();
        return view;
      });
    },
    withdraw(principal, hostedEventId, input) {
      return admin(principal, async sql => {
        const id = v.id(hostedEventId), body = v.object(input, ["expectedRevision", "auditNote"]), expected = v.version(body.expectedRevision), auditNote = v.text(body.auditNote);
        // Same O01 organization -> event -> link lock order as set/publication.
        const hosted = await deps.getHostedEvent(sql, id, { forUpdate: true }), old = await head(sql, id, true); if (!old) missing();
        if (hosted && (hosted.eventId !== id || hosted.organizationId !== old.organizationId)) stale();
        if (old.revision !== expected) conflict(old.revision);
        if (old.status === "withdrawn") return inspect(sql, hosted, old);
        const next: OfficialRuleLink = { ...old, status: "withdrawn", revision: old.revision + 1, auditNote, updatedBy: principal.actor.userId, updatedAt: deps.clock.now().toISOString() };
        const result = await sql.query("UPDATE event_official_links SET revision=$1,status='withdrawn',document=$2,updated_by=$3,updated_at=$4 WHERE hosted_event_id=$5 AND organization_id=$6 AND revision=$7", [next.revision, JSON.stringify(next), next.updatedBy, next.updatedAt, id, old.organizationId, expected]);
        if (result.rowCount !== 1) conflict((await head(sql, id))?.revision ?? 0);
        await writeHistory(sql, principal, next, "withdraw");
        return inspect(sql, hosted, next);
      });
    },
    history(principal, hostedEventId) {
      return admin(principal, async sql => {
        const id = v.id(hostedEventId); await currentView(sql, id);
        const result = await sql.query<{ document: OfficialRuleLink }>("SELECT document FROM event_official_link_history WHERE hosted_event_id=$1 ORDER BY revision DESC LIMIT 200", [id]);
        return result.rows.map(row => row.document);
      });
    },
    async getLinkedEventId(sql, scope, options = {}) {
      // Ordinary lists must not accumulate organization/M03 locks across multiple events.
      // Trusted writes opt in only after root locks their private project/confirmation facts.
      const forUpdate = Boolean(options.forUpdate);
      const hosted = await deps.getHostedEvent(sql, v.id(scope.eventId), { forUpdate });
      if (!sameHosted(hosted, scope) || scope.status !== "published" || scope.publishedRevision === null) return null;
      const link = await head(sql, scope.eventId, forUpdate ? "share" : false); if (!link || link.status !== "active") return null;
      const view = await inspect(sql, hosted, link, forUpdate); if (view.state !== "active") return null;
      const after = await deps.getHostedEvent(sql, scope.eventId, { forUpdate });
      if (!sameHosted(after, scope)) return null;
      const latestLink = await head(sql, scope.eventId, forUpdate ? "share" : false);
      if (!latestLink || latestLink.status !== "active" || latestLink.revision !== link.revision || latestLink.organizationId !== link.organizationId
        || latestLink.hostedPublishedRevision !== link.hostedPublishedRevision || latestLink.linkedEventId !== link.linkedEventId || latestLink.rulesVersion !== link.rulesVersion) return null;
      const latestRules = v.published(await deps.rulesPort.getPublished(sql, link.linkedEventId, { forUpdate }), link.linkedEventId);
      return latestRules?.publishedVersion === link.rulesVersion ? link.linkedEventId : null;
    },
  };
}
