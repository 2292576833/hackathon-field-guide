import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "../shared/errors.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import type { Clock, IdGenerator } from "../shared/contracts.ts";

/**
 * 插件接入（MCP）的个人访问令牌。
 *
 * 宪法 XV：只存哈希、可撤销即时生效、默认只读、ai:ask 单独授权并单独限流。
 * 令牌明文只在创建时返回一次，服务端永远不保存它。
 */
export const MCP_SCOPES = ["events:read", "me:read", "hall:read", "ai:ask"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpTokenView {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly McpScope[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly callCount: number;
}

export interface McpTokenGrant {
  readonly token: McpTokenView;
  /** 明文，仅此一次。 */
  readonly secret: string;
}

export interface McpPrincipal {
  readonly userId: string;
  readonly tokenId: string;
  readonly scopes: readonly McpScope[];
}

const PREFIX = "hfg_";
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();

function scopesOf(value: unknown): McpScope[] {
  if (!Array.isArray(value) || value.length === 0) throw new DomainError("MCP_SCOPE_REQUIRED", "至少选择一个权限。", { status: 422 });
  const unique = [...new Set(value)];
  if (unique.length > MCP_SCOPES.length || unique.some(item => typeof item !== "string" || !(MCP_SCOPES as readonly string[]).includes(item)))
    throw new DomainError("MCP_SCOPE_INVALID", "权限只能是 events:read、me:read、hall:read、ai:ask。", { status: 422 });
  return unique as McpScope[];
}

export function createMcpTokenService(deps: { database: DatabasePort; clock: Clock; ids: IdGenerator; dailyAskLimit?: number }) {
  const dailyAskLimit = deps.dailyAskLimit ?? 50;

  async function create(userId: string, input: unknown): Promise<McpTokenGrant> {
    const body = (input ?? {}) as { name?: unknown; scopes?: unknown; expiresInDays?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (name === "") throw new DomainError("MCP_NAME_REQUIRED", "给这个令牌起个名字，方便以后识别。", { status: 422 });
    const scopes = scopesOf(body.scopes);
    const days = body.expiresInDays === undefined ? 90 : Number(body.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new DomainError("MCP_EXPIRY_INVALID", "有效期只能是 1–365 天。", { status: 422 });
    const raw = PREFIX + randomBytes(24).toString("base64url");
    const id = deps.ids.next();
    const now = deps.clock.now();
    const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
    await deps.database.query(
      "INSERT INTO mcp_tokens(id,user_id,name,token_hash,scopes,expires_at,created_at) VALUES($1,$2,$3,$4,$5::text[],$6::timestamptz,$7::timestamptz)",
      [id, userId, name, hash(raw), scopes, expiresAt, now.toISOString()],
    );
    return {
      secret: raw,
      token: { id, name, scopes, createdAt: now.toISOString(), expiresAt, revokedAt: null, lastUsedAt: null, callCount: 0 },
    };
  }

  async function list(userId: string): Promise<readonly McpTokenView[]> {
    const rows = await deps.database.query<Record<string, unknown>>(
      "SELECT id,name,scopes,created_at,expires_at,revoked_at,last_used_at,call_count FROM mcp_tokens WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
      [userId],
    );
    return rows.rows.map(row => ({
      id: String(row.id), name: String(row.name), scopes: row.scopes as McpScope[],
      createdAt: iso(row.created_at as Date)!,
      expiresAt: iso((row.expires_at as Date) ?? null),
      revokedAt: iso((row.revoked_at as Date) ?? null),
      lastUsedAt: iso((row.last_used_at as Date) ?? null),
      callCount: Number(row.call_count ?? 0),
    }));
  }

  async function revoke(userId: string, id: string): Promise<{ readonly revoked: true }> {
    const result = await deps.database.query(
      "UPDATE mcp_tokens SET revoked_at=$3::timestamptz WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [id, userId, deps.clock.now().toISOString()],
    );
    if (result.rowCount !== 1) throw new DomainError("MCP_TOKEN_NOT_FOUND", "没有找到这条令牌，或它已被撤销。", { status: 404 });
    return { revoked: true };
  }

  /** 每次调用都重新校验：过期或已撤销立即失效，不做缓存。 */
  async function verify(raw: string): Promise<McpPrincipal | null> {
    if (typeof raw !== "string" || !raw.startsWith(PREFIX) || raw.length > 120) return null;
    const rows = await deps.database.query<{ id: string; user_id: string; scopes: McpScope[]; revoked_at: Date | null; expires_at: Date | null }>(
      "SELECT id,user_id,scopes,revoked_at,expires_at FROM mcp_tokens WHERE token_hash=$1", [hash(raw)],
    );
    const row = rows.rows[0];
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= deps.clock.now().getTime()) return null;
    await deps.database.query("UPDATE mcp_tokens SET last_used_at=$2::timestamptz, call_count=call_count+1 WHERE id=$1", [row.id, deps.clock.now().toISOString()]);
    return { userId: row.user_id, tokenId: row.id, scopes: row.scopes };
  }

  /** ai:ask 当日额度：按 UTC 日、按令牌计。 */
  async function consumeAsk(tokenId: string): Promise<{ readonly ok: boolean; readonly used: number; readonly limit: number }> {
    const day = deps.clock.now().toISOString().slice(0, 10);
    const current = await deps.database.query<{ calls: number }>("SELECT calls FROM mcp_daily_ask WHERE token_id=$1 AND quota_day=$2::date", [tokenId, day]);
    const used = Number(current.rows[0]?.calls ?? 0);
    if (used >= dailyAskLimit) return { ok: false, used, limit: dailyAskLimit };
    await deps.database.query(
      "INSERT INTO mcp_daily_ask(token_id,quota_day,calls) VALUES($1,$2::date,1) ON CONFLICT (token_id,quota_day) DO UPDATE SET calls=mcp_daily_ask.calls+1",
      [tokenId, day],
    );
    return { ok: true, used: used + 1, limit: dailyAskLimit };
  }

  async function audit(principal: McpPrincipal, tool: string, outcome: "ok" | "denied" | "failed", errorCode: string | null, durationMs: number): Promise<void> {
    await deps.database.query(
      "INSERT INTO mcp_call_audit(id,token_id,user_id,tool,outcome,error_code,duration_ms,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)",
      [deps.ids.next(), principal.tokenId, principal.userId, tool, outcome, errorCode, Math.max(0, Math.round(durationMs)), deps.clock.now().toISOString()],
    ).catch(() => { /* 审计失败不阻断主调用 */ });
  }

  return { create, list, revoke, verify, consumeAsk, audit };
}

export type McpTokenService = ReturnType<typeof createMcpTokenService>;
