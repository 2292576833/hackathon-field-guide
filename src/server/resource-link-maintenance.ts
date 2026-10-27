import { randomUUID } from "node:crypto";
import type { Clock } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";
import { createResourceLinkCheckWorker, type ResourceLinkCheck, type ResourceLinkTransport } from "../modules/resources/link-check-worker.ts";
import { createNodeNetworkPorts } from "../modules/operations/node-network.ts";
import { normalizeSourceUrl, type NetworkPolicy, type PublicDnsPort, type PinnedFetchPort } from "../modules/operations/network-policy.ts";
import { assertRobotsAllowed } from "../modules/operations/robots-policy.ts";
import { assertOperationsAdmin, type OperationsAdminPrincipal } from "./operations-observability.ts";

type Reason = ResourceLinkCheck["reason"] | "robots_disallowed" | "robots_unavailable" | "resource_changed";
interface ApprovedEntry { id: string; revision: number; version: number; url: string; checked_url: string }
export interface ResourceLinkMaintenanceResult {
  readonly resourceId: string;
  readonly resourceRevision: number;
  readonly resourceVersion: number;
  readonly hostname: string;
  readonly checkedAt: string;
  readonly status: ResourceLinkCheck["status"];
  readonly reason: Reason;
  readonly httpStatus: number | null;
}
export interface ResourceLinkMaintenanceStatus {
  readonly observedAt: string;
  readonly state: null | { readonly cycle: string; readonly phase: "running" | "stale" | "waiting" | "ready"; readonly lastStartedAt: string | null; readonly lastCompletedAt: string | null; readonly nextEligibleAt: string };
  readonly results: readonly ResourceLinkMaintenanceResult[];
  readonly websiteMinimumIntervalHours: 24;
}

// Public version stays live during draft editing. Only its actual published M08
// review may authorize the exact entry; draft URLs and seeds lacking reviews do not.
const approvedSql = `SELECT r.id,r.revision,(r.public_document->>'version')::integer AS version,
  r.public_document->>'officialUrl' AS url,v.payload->'verification'->'link'->>'checkedUrl' AS checked_url
  FROM resource_records r JOIN operations_resource_reviews v ON v.id=r.public_document->>'reviewId' AND v.resource_id=r.id
  WHERE r.public_document->>'publicationStatus'='published' AND r.public_document->>'externalLinkBlocked'='false'
  AND v.status='published' AND (v.payload->>'publishedVersion')::integer=(r.public_document->>'version')::integer
  AND v.payload->'verification'->'link'->>'status'='available'`;
const at = (value: string | Date | null): string | null => value === null ? null : new Date(value).toISOString();
function entry(row: ApprovedEntry): ApprovedEntry | null {
  try {
    const url = normalizeSourceUrl(row.url);
    if (normalizeSourceUrl(row.checked_url) !== url || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.version) || row.version < 1) return null;
    return { ...row, url };
  } catch { return null; }
}

/** Explicit worker entry and read-only admin status; not a public GET side effect. */
export function createResourceLinkMaintenance(deps: {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly network?: { readonly dns: PublicDnsPort; readonly transport: PinnedFetchPort };
  readonly headTransport?: ResourceLinkTransport;
  readonly userAgent?: string;
  readonly proxyUrl?: string;
  readonly batchSize?: number;
  readonly timeoutMs?: number;
  readonly resolvePrincipal?: (request: Request) => Promise<OperationsAdminPrincipal | null>;
  readonly requestId?: (request: Request) => string;
}) {
  const batch = deps.batchSize ?? 3, timeoutMs = deps.timeoutMs ?? 8000;
  const userAgent = deps.userAgent ?? "HackathonFieldGuide/0.1 resource-link-maintenance";
  if (!Number.isInteger(batch) || batch < 1 || batch > 5 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) throw new DomainError("INVALID_RESOURCE_CHECK_POLICY", "每轮检查需为 1 至 5 个网站，并使用有界超时。");
  const network = deps.network ?? createNodeNetworkPorts({ userAgent, proxyUrl: deps.proxyUrl });
  const leaseMs = Math.max(120000, batch * timeoutMs + 30000);

  async function current(sql: SqlExecutor, captured: ApprovedEntry): Promise<boolean> {
    const row = (await sql.query<ApprovedEntry>(`${approvedSql} AND r.id=$1 AND r.revision=$2`, [captured.id, captured.revision])).rows[0];
    const found = row && entry(row);
    return Boolean(found && found.version === captured.version && found.url === captured.url);
  }
  async function liveLease(token: string): Promise<boolean> {
    return (await deps.database.query("SELECT id FROM resource_link_maintenance_state WHERE id='approved_resources' AND lease_token=$1 AND lease_until>$2::timestamptz", [token, deps.clock.now().toISOString()])).rowCount === 1;
  }
  const api = {
    async runOnce(input: { readonly signal?: AbortSignal } = {}): Promise<{ readonly status: "completed" | "waiting" | "busy" | "cancelled"; readonly cycle: string | null; readonly checked: number; readonly skippedChanged: number }> {
      if (input.signal?.aborted) return { status: "cancelled", cycle: null, checked: 0, skippedChanged: 0 };
      const token = randomUUID(), now = deps.clock.now().toISOString();
      const claimed = await deps.database.transaction(async sql => {
        await sql.query("INSERT INTO resource_link_maintenance_state(id,next_eligible_at) VALUES('approved_resources',$1::timestamptz) ON CONFLICT DO NOTHING", [now]);
        const result = await sql.query<{cycle: string}>("UPDATE resource_link_maintenance_state SET cycle=cycle+1,lease_token=$1,lease_until=$2::timestamptz,last_started_at=$3::timestamptz WHERE id='approved_resources' AND (lease_until IS NULL OR lease_until<=$3::timestamptz) AND next_eligible_at<=$3::timestamptz RETURNING cycle::text", [token, new Date(Date.parse(now) + leaseMs).toISOString(), now]);
        if (result.rowCount) return { cycle: result.rows[0]!.cycle, status: "claimed" as const };
        const state = (await sql.query<{lease_until: string | Date | null}>("SELECT lease_until FROM resource_link_maintenance_state WHERE id='approved_resources'")).rows[0];
        return { cycle: null, status: state?.lease_until && new Date(state.lease_until).getTime() > Date.parse(now) ? "busy" as const : "waiting" as const };
      });
      if (claimed.status !== "claimed") return { status: claimed.status, cycle: null, checked: 0, skippedChanged: 0 };
      let checked = 0, skippedChanged = 0, cancelled = false, completed = false;
      try {
        const candidates = (await deps.database.query<ApprovedEntry>(`${approvedSql}
          ORDER BY (SELECT max(c.checked_at) FROM resource_link_check_results c WHERE c.resource_id=r.id AND c.resource_revision=r.revision) ASC NULLS FIRST,r.id LIMIT 100`)).rows.map(entry).filter((item): item is ApprovedEntry => item !== null);
        const approved = [...new Set(candidates.map(item => item.url))];
        // Persisted host admission happens BEFORE robots/HEAD. Failure/cancellation
        // still consumes the website interval, so reboot cannot create a burst.
        let admitted = 0;
        for (const candidate of candidates) {
          if (admitted >= batch || input.signal?.aborted) { cancelled = Boolean(input.signal?.aborted); break; }
          if (!await liveLease(token)) break;
          const hostname = new URL(candidate.url).hostname;
          const hostClaim = await deps.database.transaction(async sql => {
            if (!await current(sql, candidate)) return false;
            const at = deps.clock.now().toISOString();
            const global = await sql.query("SELECT id FROM resource_link_maintenance_state WHERE id='approved_resources' AND lease_token=$1 AND lease_until>$2::timestamptz FOR UPDATE", [token, at]);
            if (!global.rowCount) return false;
            return (await sql.query("INSERT INTO resource_link_maintenance_sites(hostname,last_attempt_at,next_eligible_at) VALUES($1,$2::timestamptz,$2::timestamptz+interval '24 hours') ON CONFLICT(hostname) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,next_eligible_at=excluded.next_eligible_at WHERE resource_link_maintenance_sites.next_eligible_at<=$2::timestamptz RETURNING hostname", [hostname, at])).rowCount === 1;
          });
          if (!hostClaim) continue;
          admitted++;
          const admittedHosts = new Set([hostname]);
          let extraReason: Reason | null = null;
          const baseTransport = deps.headTransport;
          // Reuse M09's executable DNS-pinned HEAD and exact-url redirect worker.
          // This decorator adds native pinned robots verification on EVERY hop.
          const transport: ResourceLinkTransport = { async head(url, signal) {
            const merged = input.signal ? AbortSignal.any([signal, input.signal]) : signal;
            merged.throwIfAborted();
            const targets = candidates.filter(item => item.url === url);
            if (!await liveLease(token) || !await current(deps.database, candidate) || !(await Promise.all(targets.map(item => current(deps.database, item)))).some(Boolean)) {
              extraReason = "resource_changed";
              throw new DomainError("RESOURCE_CHECK_CHANGED", "资源审批版本已经改变。", { status: 409 });
            }
            const parsed = new URL(url);
            if (!admittedHosts.has(parsed.hostname)) {
              const admittedRedirect = await deps.database.transaction(async sql => {
                const checkedAt = deps.clock.now().toISOString();
                const live = await sql.query("SELECT id FROM resource_link_maintenance_state WHERE id='approved_resources' AND lease_token=$1 AND lease_until>$2::timestamptz FOR UPDATE", [token, checkedAt]);
                if (!live.rowCount) return false;
                return (await sql.query("INSERT INTO resource_link_maintenance_sites(hostname,last_attempt_at,next_eligible_at) VALUES($1,$2::timestamptz,$2::timestamptz+interval '24 hours') ON CONFLICT(hostname) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,next_eligible_at=excluded.next_eligible_at WHERE resource_link_maintenance_sites.next_eligible_at<=$2::timestamptz RETURNING hostname", [parsed.hostname, checkedAt])).rowCount === 1;
              });
              if (!admittedRedirect) {
                extraReason = "http_restricted";
                throw new DomainError("RESOURCE_SITE_INTERVAL", "该跳转网站尚未到检查时间。", { status: 429 });
              }
              admittedHosts.add(parsed.hostname);
            }
            const policy: NetworkPolicy = { version: 1, rules: [{hostname: parsed.hostname, pathPrefix: parsed.pathname}], maxRedirects: 2, maxBytes: 65536, timeoutMs, acceptedContentTypes: ["text/plain"] };
            try { await assertRobotsAllowed({ sourceUrl: url, policy, dns: network.dns, transport: network.transport, userAgent, signal: merged }); }
            catch (error) {
              extraReason = isDomainError(error) && error.code === "ROBOTS_DISALLOWED" ? "robots_disallowed" : "robots_unavailable";
              throw error;
            }
            merged.throwIfAborted();
            // A slow robots lookup must not authorize an expired lease or an old
            // revision. The default HEAD transport never inherits ambient secrets.
            if (!await liveLease(token) || !await current(deps.database, candidate) || !(await Promise.all(targets.map(item => current(deps.database, item)))).some(Boolean)) {
              extraReason = "resource_changed";
              throw new DomainError("RESOURCE_CHECK_CHANGED", "资源审批版本已经改变。", { status: 409 });
            }
            if (baseTransport) return baseTransport.head(url, merged);
            const { createNodeResourceLinkTransport } = await import("../modules/resources/link-check-worker.ts");
            return createNodeResourceLinkTransport().head(url, merged);
          } };
          const result = await createResourceLinkCheckWorker({ approvedUrls: approved, clock: deps.clock, transport, timeoutMs, maxRedirects: 3 }).check(candidate.url);
          const saved = await deps.database.transaction(async sql => {
            const at = deps.clock.now().toISOString();
            const resource = await sql.query("SELECT id FROM resource_records WHERE id=$1 AND revision=$2 FOR SHARE", [candidate.id, candidate.revision]);
            if (!resource.rowCount || !await current(sql, candidate)) return false;
            const state = await sql.query("SELECT id FROM resource_link_maintenance_state WHERE id='approved_resources' AND lease_token=$1 AND lease_until>$2::timestamptz FOR UPDATE", [token, at]);
            if (!state.rowCount) return false;
            await sql.query(`INSERT INTO resource_link_check_results(resource_id,resource_revision,resource_version,hostname,checked_at,status,reason,http_status,cycle)
              VALUES($1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9::bigint)
              ON CONFLICT(resource_id,resource_revision) DO UPDATE SET resource_version=excluded.resource_version,hostname=excluded.hostname,checked_at=excluded.checked_at,status=excluded.status,reason=excluded.reason,http_status=excluded.http_status,cycle=excluded.cycle`,
              [candidate.id, candidate.revision, candidate.version, hostname, result.checkedAt, result.status, result.reason === "request_timeout" ? "request_timeout" : extraReason ?? result.reason, result.httpStatus && result.httpStatus >= 100 && result.httpStatus <= 599 ? result.httpStatus : null, claimed.cycle]);
            return true;
          });
          if (saved) checked++; else skippedChanged++;
        }
        completed = !cancelled;
        return { status: cancelled ? "cancelled" : "completed", cycle: claimed.cycle, checked, skippedChanged };
      } finally {
        const at = deps.clock.now().toISOString();
        await deps.database.query("UPDATE resource_link_maintenance_state SET lease_token=NULL,lease_until=NULL,last_completed_at=CASE WHEN $3 THEN $2::timestamptz ELSE last_completed_at END,next_eligible_at=$2::timestamptz+interval '60 seconds' WHERE id='approved_resources' AND lease_token=$1 AND lease_until>$2::timestamptz", [token, at, completed]);
      }
    },
    async status(principal: OperationsAdminPrincipal, input: { readonly limit?: number } = {}): Promise<ResourceLinkMaintenanceStatus> {
      const limit = input.limit ?? 30;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_RESOURCE_CHECK_QUERY", "每次可查看 1 至 100 条检查记录。");
      return deps.database.transaction(async sql => {
        await assertOperationsAdmin(principal, sql);
        const now = deps.clock.now().toISOString();
        const state = (await sql.query<{cycle: string; lease_until: Date | string | null; next_eligible_at: Date | string; last_started_at: Date | string | null; last_completed_at: Date | string | null}>("SELECT cycle::text,lease_until,next_eligible_at,last_started_at,last_completed_at FROM resource_link_maintenance_state WHERE id='approved_resources'")).rows[0];
        const results = (await sql.query<{resource_id: string; resource_revision: number; resource_version: number; hostname: string; checked_at: Date | string; status: ResourceLinkCheck["status"]; reason: Reason; http_status: number | null}>(`SELECT c.resource_id,c.resource_revision,c.resource_version,c.hostname,c.checked_at,c.status,c.reason,c.http_status FROM resource_link_check_results c
          JOIN resource_records r ON r.id=c.resource_id AND r.revision=c.resource_revision
          WHERE r.public_document->>'publicationStatus'='published' AND r.public_document->>'externalLinkBlocked'='false'
          AND (r.public_document->>'version')::integer=c.resource_version
          ORDER BY c.checked_at DESC,c.resource_id LIMIT $1`, [limit])).rows;
        await assertOperationsAdmin(principal, sql);
        return { observedAt: now, websiteMinimumIntervalHours: 24, state: !state ? null : {
          cycle: state.cycle, phase: state.lease_until ? new Date(state.lease_until).getTime() > Date.parse(now) ? "running" : "stale" : new Date(state.next_eligible_at).getTime() > Date.parse(now) ? "waiting" : "ready",
          lastStartedAt: at(state.last_started_at), lastCompletedAt: at(state.last_completed_at), nextEligibleAt: at(state.next_eligible_at)!,
        }, results: results.map(item => ({ resourceId: item.resource_id, resourceRevision: item.resource_revision, resourceVersion: item.resource_version, hostname: item.hostname, checkedAt: at(item.checked_at)!, status: item.status, reason: item.reason, httpStatus: item.http_status })) };
      });
    },
  };
  return { ...api, handlers: { status: async (request: Request): Promise<Response> => {
    const requestId = deps.requestId?.(request) ?? randomUUID();
    const headers = { "Cache-Control": "no-store, private", Vary: "Cookie, Authorization" };
    try {
      if (request.method !== "GET") throw new DomainError("METHOD_NOT_ALLOWED", "此入口只读取已保存的检查结果。", { status: 405 });
      if (!deps.resolvePrincipal) throw new DomainError("RESOURCE_CHECK_AUTH_UNCONFIGURED", "管理员身份查询尚未接入。", { status: 503 });
      const principal = await deps.resolvePrincipal(request);
      if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
      const params = new URL(request.url).searchParams;
      if ([...params.keys()].some(key => key !== "limit" || params.getAll(key).length !== 1)) throw new DomainError("INVALID_RESOURCE_CHECK_QUERY", "检查结果查询参数无效。");
      return Response.json({ data: await api.status(principal, { limit: params.has("limit") ? Number(params.get("limit")) : undefined }), requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  } } };
}
