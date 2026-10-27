import { createHash } from "node:crypto";
import type { DatabasePort } from "../shared/persistence.ts";
import type { Clock, Actor } from "../shared/contracts.ts";
import type { ApplicationConfig } from "./config.ts";
import { DomainError } from "../shared/errors.ts";
import { PostgresDiscoveryLedger } from "../modules/operations/discovery-postgres.ts";
import { inspirationSeed, inspirationCandidates, type InspirationItem, type InspirationCatalogStatus } from "./inspiration-catalog.ts";

export interface InspirationFeed { items: InspirationItem[]; pendingItems: typeof inspirationCandidates; status: InspirationCatalogStatus }
const hostname = (value: string) => new URL(value).hostname.replace(/^www\./, "");
export function createInspirationService(database: DatabasePort, clock: Clock, config: ApplicationConfig) {
  const ledger = new PostgresDiscoveryLedger({ database, clock, id: "inspiration-catalog" });
  let cache: { until: number; value: InspirationFeed } | null = null;
  let pending: Promise<InspirationFeed> | null = null;
  function normalize(item: InspirationItem): InspirationItem {
    const seed = inspirationSeed.find(candidate => candidate.id === item?.id);
    if (!seed || item.name !== seed.name || item.url !== seed.url || item.category !== seed.category || item.contentType !== seed.contentType || JSON.stringify(item.tags) !== JSON.stringify(seed.tags)) throw new DomainError("INVALID_INSPIRATION", "灵感站点信息与已知官网不一致。", { status: 422 });
    const text = (value: unknown) => { if (typeof value !== "string" || !value.trim() || value.length > 800 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new DomainError("INVALID_INSPIRATION", "灵感分析内容无效。", { status: 422 }); return value.trim(); };
    if (!/^\d{4}-\d{2}-\d{2}T/.test(item.checkedAt) || !Number.isFinite(Date.parse(item.checkedAt)) || Date.parse(item.checkedAt) > clock.now().getTime() + 300_000) throw new DomainError("INVALID_INSPIRATION", "灵感分析时间无效。", { status: 422 });
    if (!Array.isArray(item.evidenceUrls) || !item.evidenceUrls.length || item.evidenceUrls.length > 3) throw new DomainError("INVALID_INSPIRATION", "灵感分析缺少官网依据。", { status: 422 });
    const evidenceUrls = item.evidenceUrls.map(value => {
      try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.port || ![seed.url, ...seed.evidenceUrls].some(source => hostname(source) === hostname(value))) throw new Error(); return url.href; }
      catch { throw new DomainError("INVALID_INSPIRATION", "灵感依据必须来自对应官网。", { status: 422 }); }
    });
    return { ...seed, description: text(item.description), useWhen: text(item.useWhen), usageNote: text(item.usageNote), checkedAt: new Date(item.checkedAt).toISOString(), evidenceUrls };
  }
  async function save(input: InspirationItem): Promise<{ id: string; revision: number }> {
    const item = normalize(input);
    const result = await database.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`inspiration:${item.id}`]);
      const current = (await tx.query<{ revision: number; content_hash: string; last_analyzed_at: Date }>("SELECT revision,content_hash,last_analyzed_at FROM inspiration_cards WHERE id=$1 FOR UPDATE", [item.id])).rows[0];
      if (current && new Date(current.last_analyzed_at).getTime() > Date.parse(item.checkedAt)) return { id: item.id, revision: current.revision };
      const hash = createHash("sha256").update(JSON.stringify({ ...item, checkedAt: undefined })).digest("hex");
      if (current?.content_hash === hash) { await tx.query("UPDATE inspiration_cards SET content=$2::jsonb,last_analyzed_at=$3,updated_at=now() WHERE id=$1", [item.id, JSON.stringify(item), item.checkedAt]); return { id: item.id, revision: current.revision }; }
      const revision = (current?.revision ?? 0) + 1;
      await tx.query("INSERT INTO inspiration_cards(id,revision,content_hash,content,last_analyzed_at) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,content=excluded.content,last_analyzed_at=excluded.last_analyzed_at,updated_at=now()", [item.id, revision, hash, JSON.stringify(item), item.checkedAt]);
      await tx.query("INSERT INTO inspiration_versions(card_id,revision,content_hash,content) VALUES($1,$2,$3,$4::jsonb)", [item.id, revision, hash, JSON.stringify(item)]);
      return { id: item.id, revision };
    });
    cache = null;
    return result;
  }
  async function snapshot(): Promise<InspirationFeed> {
    if (cache && cache.until > clock.now().getTime()) return structuredClone(cache.value);
    if (!pending) pending = (async () => {
      const rows = (await database.query<{ content: InspirationItem }>("SELECT content FROM inspiration_cards ORDER BY id")).rows;
      const items = rows.map(row => row.content).filter(item => inspirationCandidates.some(candidate => candidate.id === item.id));
      const ids = new Set(items.map(item => item.id));
      const pendingItems = inspirationCandidates.filter(item => !ids.has(item.id));
      const row = (await database.query<{ paused: boolean; lease_expires_at: Date | null; quota_day: string; model_calls: number; estimated_cost_micros: string | number; last_error_code: string | null }>("SELECT paused,lease_expires_at,quota_day,model_calls,estimated_cost_micros,last_error_code FROM operations_discovery_state WHERE id='inspiration-catalog'")).rows[0];
      const worker = config.inspiration;
      const heartbeat = worker ? (await database.query<{ status: string; last_seen_at: Date }>("SELECT status,last_seen_at FROM backend_worker_heartbeats WHERE kind='inspiration' ORDER BY (status<>'stopped' AND last_seen_at>now()-interval '120 seconds') DESC,last_seen_at DESC LIMIT 1")).rows[0] : null;
      const online = heartbeat && heartbeat.status !== "stopped" && clock.now().getTime() - new Date(heartbeat.last_seen_at).getTime() <= 120_000;
      const sameDay = row?.quota_day === clock.now().toISOString().slice(0,10);
      const limited = worker && row && ((sameDay ? row.model_calls : 0) + 1 > worker.limits.maxModelCallsPerDay || (sameDay ? Number(row.estimated_cost_micros) : 0) + worker.modelCostReservationMicrosPerCall > worker.limits.maxEstimatedCostMicrosPerDay);
      const active = row?.lease_expires_at && new Date(row.lease_expires_at).getTime() > clock.now().getTime();
      let message = !worker || !config.dsh ? "DSH 灵感更新尚未启用" : row?.paused ? "DSH 灵感更新已暂停" : !online ? "灵感后台暂未运行，已保存结果仍可浏览" : active ? "DSH 正在读取官网并分析" : limited ? "今日剩余额度不足以开始下一次灵感分析，下一配额日继续" : row?.last_error_code ? "部分官网暂时无法完成分析，已保存结果仍可浏览" : pendingItems.length ? "DSH 将依次读取官网并补充分析" : "DSH 定期检查官网，有变化时更新说明";
      message += ` · 已分析 ${items.length} / ${inspirationCandidates.length}`;
      const updatedAt = items.map(item => item.checkedAt).sort().at(-1) ?? null;
      const value: InspirationFeed = { items, pendingItems, status: { kind: "dsh", message, updatedAt } };
      cache = { until: clock.now().getTime()+1000, value };
      return value;
    })().finally(() => { pending = null; });
    return structuredClone(await pending);
  }
  async function setPaused(actor: Actor, value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INVALID_INPUT", "请提供灵感调度参数。");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !["expectedRevision", "paused"].includes(key)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision)<1 || typeof input.paused !== "boolean") throw new DomainError("INVALID_INPUT", "调度版本或暂停状态无效。");
    return database.transaction(async tx => {
      const fresh = await tx.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL AND 'admin'=ANY(platform_roles) FOR SHARE", [actor.userId]);
      if (!fresh.rows.length) throw new DomainError("FORBIDDEN", "此操作需要当前有效的管理员权限。", { status: 403 });
      const state = await ledger.setPaused({ actorId: actor.userId, expectedRevision: Number(input.expectedRevision), paused: input.paused as boolean, now: clock.now().toISOString() }); cache=null; return state;
    });
  }
  return { save, snapshot, setPaused, ledger, status: () => ledger.readState() };
}
