import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Actor, Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import type { TransactionalEmailTransportPort } from "../modules/auth/email-adapter.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";

export type OrganizerMailProvider = "qq" | "163" | "126" | "gmail";
export interface OrganizerSmtpConfiguration { readonly host: string; readonly port: 465; readonly secure: true; readonly user: string; readonly password: string; }
export interface OrganizerMailAccountMetadata {
 organizationId: string; revision: number; state: "unconfigured" | "verified" | "disabled";
 provider: OrganizerMailProvider | null; maskedEmail: string | null; verifiedAt: string | null; updatedAt: string | null;
}
interface OrganizationScope { readonly id: string; readonly status: "pending" | "approved" | "rejected" | "suspended"; }
export interface OrganizerMailAccountDependencies {
 database: DatabasePort; clock: Clock; ids: IdGenerator;
 /** Root derives a separate-purpose 32-byte key from stable server key material; never supplied by HTTP. */
 encryptionKey: Uint8Array;
 requireOrganizationManager(sql: SqlExecutor, actor: Actor, organizationId: string): Promise<OrganizationScope>;
 getOrganization(sql: SqlExecutor, organizationId: string): Promise<OrganizationScope | null>;
 resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
 assertMutationAllowed(request: Request): Promise<void>;
 /** True only after actual TLS SMTP login verification. No sendMail, recipient or email body here. */
 verifyCredentials(config: OrganizerSmtpConfiguration, options: { signal: AbortSignal }): Promise<boolean>;
 createSmtpMailTransport(config: OrganizerSmtpConfiguration): TransactionalEmailTransportPort;
 verificationTimeoutMs?: number;
}
interface Ciphertext { version: 1; iv: string; tag: string; data: string; }
interface Stored {
 organization_id: string; revision: number; state: "verified" | "disabled"; provider: OrganizerMailProvider | null;
 masked_email: string | null; verified_at: Date | string | null; updated_at: Date | string; credential?: Ciphertext | null;
}
const PROFILE_HOSTS: Record<OrganizerMailProvider, string> = { qq: "smtp.qq.com", "163": "smtp.163.com", "126": "smtp.126.com", gmail: "smtp.gmail.com" };
const PROFILES = [
 { id: "qq" as const, label: "QQ 邮箱", note: "先在邮箱设置中开启 SMTP，填写邮箱授权码。" },
 { id: "163" as const, label: "163 邮箱", note: "先在邮箱设置中开启 SMTP，填写客户端授权码。" },
 { id: "126" as const, label: "126 邮箱", note: "先在邮箱设置中开启 SMTP，填写客户端授权码。" },
 { id: "gmail" as const, label: "Gmail", note: "使用 Google 应用专用密码；账号需支持并启用此功能。" },
];
const METADATA_COLUMNS = "organization_id,revision,state,provider,masked_email,verified_at,updated_at";
const MAILBOX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
function invalid(message = "请填写正确的邮箱和授权码。"): never { throw new DomainError("ORGANIZER_MAIL_INVALID_INPUT", message); }
function unavailable(): never { throw new DomainError("ORGANIZER_MAIL_UNAVAILABLE", "发信账号暂时无法读取，请联系网站管理员。", { status: 503 }); }
function forbidden(): never { throw new DomainError("ORGANIZER_MAIL_FORBIDDEN", "只有当前已通过认证的机构管理员可以设置发信邮箱。", { status: 403 }); }
function valueObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid("请使用页面提供的邮箱配置项，不能填写自定义 SMTP 地址。");
 return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
 if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid(); return value.trim();
}
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) return invalid("版本无效，请刷新设置后重试。"); return Number(value); }
function matches(expected: number, actual: number) {
 if (expected !== actual) throw new DomainError("ORGANIZER_MAIL_REVISION_CONFLICT", "发信设置已更新，本次配置未保存。请重新读取并核对。", { status: 409, latestRevision: actual });
}
function mask(email: string): string { const [local, domain] = email.split("@"); return `${local.slice(0, 1)}***@${domain}`; }
function configuration(provider: OrganizerMailProvider, email: string, password: string): OrganizerSmtpConfiguration {
 if (!Object.hasOwn(PROFILE_HOSTS, provider) || !MAILBOX.test(email) || email.length > 254 || !password || password.length > 4096 || /[\u0000-\u001f\u007f]/.test(password)) return unavailable();
 return { host: PROFILE_HOSTS[provider], port: 465, secure: true, user: email, password };
}
function metadata(organizationId: string, row: Stored | null): OrganizerMailAccountMetadata {
 return row ? { organizationId, revision: row.revision, state: row.state, provider: row.provider, maskedEmail: row.masked_email, verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null, updatedAt: new Date(row.updated_at).toISOString() } : { organizationId, revision: 0, state: "unconfigured", provider: null, maskedEmail: null, verifiedAt: null, updatedAt: null };
}

/** Organization-owned SMTP credentials; fixed official hosts, encrypted at rest, never returned to HTTP. */
export function createOrganizerMailAccounts(deps: OrganizerMailAccountDependencies) {
 if (!(deps.encryptionKey instanceof Uint8Array) || deps.encryptionKey.byteLength !== 32) throw new Error("Organizer mail encryption requires a separate 32-byte server key.");
 const key = Buffer.from(deps.encryptionKey), timeoutMs = deps.verificationTimeoutMs ?? 9000;
 if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error("Invalid organizer SMTP verification timeout.");
 const now = () => deps.clock.now().toISOString();
 const aad = (organizationId: string, version: number, provider: OrganizerMailProvider, maskedEmail: string) => Buffer.from(JSON.stringify(["organizer-mail-account:v1", organizationId, version, provider, maskedEmail]));
 function encrypt(organizationId: string, version: number, provider: OrganizerMailProvider, email: string, password: string): Ciphertext {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 }); cipher.setAAD(aad(organizationId, version, provider, mask(email)));
  const data = Buffer.concat([cipher.update(JSON.stringify({ email, authorizationCode: password }), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
 }
 function decrypt(row: Stored): OrganizerSmtpConfiguration {
  try {
   const encrypted = row.credential;
   if (!encrypted || encrypted.version !== 1 || !row.provider || !row.masked_email || ![encrypted.iv, encrypted.tag, encrypted.data].every(item => typeof item === "string" && /^[A-Za-z0-9_-]+$/.test(item)) || encrypted.data.length > 22000) return unavailable();
   const iv = Buffer.from(encrypted.iv, "base64url"), tag = Buffer.from(encrypted.tag, "base64url"); if (iv.length !== 12 || tag.length !== 16) return unavailable();
   const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 }); decipher.setAAD(aad(row.organization_id, row.revision, row.provider, row.masked_email)); decipher.setAuthTag(tag);
   const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64url")), decipher.final()]).toString("utf8")) as { email: string; authorizationCode: string };
   if (typeof value.email !== "string" || typeof value.authorizationCode !== "string" || mask(value.email) !== row.masked_email) return unavailable();
   return configuration(row.provider, value.email, value.authorizationCode);
  } catch { return unavailable(); }
 }
 async function authorize(sql: SqlExecutor, principal: OrganizerPrincipal, organizationId: string) {
  await principal.guard(sql); const org = await deps.requireOrganizationManager(sql, principal.actor, organizationId);
  if (org.id !== organizationId || org.status !== "approved") return forbidden(); return org;
 }
 async function read(sql: SqlExecutor, organizationId: string, lock = false) {
  return (await sql.query<Stored>(`SELECT ${METADATA_COLUMNS} FROM organizer_mail_accounts WHERE organization_id=$1${lock ? " FOR UPDATE" : ""}`, [organizationId])).rows[0] ?? null;
 }
 async function get(principal: OrganizerPrincipal, organizationId: string) {
  text(organizationId, 200);
  return deps.database.transaction(async sql => { await authorize(sql, principal, organizationId); const result = metadata(organizationId, await read(sql, organizationId)); await authorize(sql, principal, organizationId); return { ...result, profiles: PROFILES.map(profile => ({ ...profile })) }; });
 }
 async function audit(sql: SqlExecutor, principal: OrganizerPrincipal, before: OrganizerMailAccountMetadata, after: OrganizerMailAccountMetadata, action: "verified_saved" | "disabled") {
  await sql.query("INSERT INTO organizer_mail_account_audit(id,organization_id,revision,actor_user_id,action,before_metadata,after_metadata,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [deps.ids.next(), after.organizationId, after.revision, principal.actor.userId, action, JSON.stringify(before), JSON.stringify(after), now()]);
 }
 async function verify(config: OrganizerSmtpConfiguration): Promise<"verified" | "failed" | "unknown_hold"> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   const verified = await Promise.race([deps.verifyCredentials(config, { signal: controller.signal }), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("SMTP verification timed out.")); }, timeoutMs); })]);
   return verified === true ? "verified" : "failed";
  } catch { return "unknown_hold"; }
  finally { if (timer !== undefined) clearTimeout(timer); }
 }
 async function save(principal: OrganizerPrincipal, organizationId: string, input: unknown) {
  text(organizationId, 200); const body = valueObject(input, ["expectedRevision", "provider", "email", "authorizationCode"]), expected = revision(body.expectedRevision);
  if (typeof body.provider !== "string" || !Object.hasOwn(PROFILE_HOSTS, body.provider)) return invalid("请选择 QQ、163、126 或 Gmail。Outlook 需要 OAuth2，当前授权码方式暂不支持。");
  const provider = body.provider as OrganizerMailProvider, email = text(body.email, 254).toLowerCase(), password = text(body.authorizationCode, 4096);
  if (!MAILBOX.test(email)) return invalid("请输入完整邮箱地址，发件地址必须是此邮箱本人。");
  const config = configuration(provider, email, password);
  // Permission/CAS check before external work, with no transaction held during SMTP verification.
  const attemptId = await deps.database.transaction(async sql => {
   await authorize(sql, principal, organizationId); matches(expected, (await read(sql, organizationId, true))?.revision ?? 0);
   const latest = (await sql.query<{ requested_at: Date | string }>("SELECT requested_at FROM organizer_mail_verification_attempts WHERE organization_id=$1 ORDER BY sequence DESC LIMIT 1", [organizationId])).rows[0];
   const instant = deps.clock.now(), start = new Date(`${instant.toISOString().slice(0, 10)}T00:00:00.000Z`), end = new Date(start.getTime() + 86400000);
   if (latest && instant.getTime() < new Date(latest.requested_at).getTime() + 60000) throw new DomainError("ORGANIZER_MAIL_VERIFICATION_RATE_LIMIT", "每家机构至少间隔60秒再验证邮箱，本次没有发起验证。", { status: 429, recoveryAction: `请在 ${new Date(new Date(latest.requested_at).getTime() + 60000).toISOString()} 后再次明确提交。` });
   const daily = (await sql.query<{ n: number }>("SELECT count(*)::int AS n FROM organizer_mail_verification_attempts WHERE organization_id=$1 AND requested_at>=$2 AND requested_at<$3", [organizationId, start.toISOString(), end.toISOString()])).rows[0].n;
   if (daily >= 10) throw new DomainError("ORGANIZER_MAIL_VERIFICATION_DAILY_LIMIT", "这家机构已达到今日10次邮箱验证上限，本次没有发起验证。", { status: 429, recoveryAction: `请在 ${end.toISOString()} 后再次明确提交。` });
   const id = deps.ids.next(); await sql.query("INSERT INTO organizer_mail_verification_attempts(id,organization_id,actor_user_id,state,requested_at,updated_at) VALUES($1,$2,$3,'verifying',$4,$4)", [id, organizationId, principal.actor.userId, now()]); await authorize(sql, principal, organizationId); return id;
  });
  const verification = await verify(config);
  await deps.database.transaction(async sql => { await sql.query("UPDATE organizer_mail_verification_attempts SET state=$1,updated_at=$2 WHERE id=$3 AND organization_id=$4 AND state='verifying'", [verification, now(), attemptId, organizationId]); });
  if (verification !== "verified") throw new DomainError("ORGANIZER_MAIL_VERIFICATION_FAILED", "本次邮箱登录验证未完成，配置未保存。请检查 SMTP 是否开启及授权码是否正确；原有设置已保留。", { status: 503 });
  return deps.database.transaction(async sql => {
   await authorize(sql, principal, organizationId); const old = await read(sql, organizationId, true); matches(expected, old?.revision ?? 0);
   const timestamp = now(), next = expected + 1, encrypted = encrypt(organizationId, next, provider, email, password);
   await sql.query("INSERT INTO organizer_mail_accounts(organization_id,revision,state,provider,masked_email,credential,verified_at,updated_at) VALUES($1,$2,'verified',$3,$4,$5,$6,$6) ON CONFLICT(organization_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,provider=excluded.provider,masked_email=excluded.masked_email,credential=excluded.credential,verified_at=excluded.verified_at,updated_at=excluded.updated_at", [organizationId, next, provider, mask(email), JSON.stringify(encrypted), timestamp]);
   const result: OrganizerMailAccountMetadata = { organizationId, revision: next, state: "verified", provider, maskedEmail: mask(email), verifiedAt: timestamp, updatedAt: timestamp };
   await audit(sql, principal, metadata(organizationId, old), result, "verified_saved"); await authorize(sql, principal, organizationId);
   return { ...result, profiles: PROFILES.map(profile => ({ ...profile })) };
  });
 }
 async function disable(principal: OrganizerPrincipal, organizationId: string, input: unknown) {
  text(organizationId, 200); const body = valueObject(input, ["expectedRevision"]), expected = revision(body.expectedRevision);
  return deps.database.transaction(async sql => {
   await authorize(sql, principal, organizationId); const old = await read(sql, organizationId, true); matches(expected, old?.revision ?? 0);
   const result: OrganizerMailAccountMetadata = { organizationId, revision: expected + 1, state: "disabled", provider: old?.provider ?? null, maskedEmail: old?.masked_email ?? null, verifiedAt: null, updatedAt: now() };
   await sql.query("INSERT INTO organizer_mail_accounts(organization_id,revision,state,provider,masked_email,credential,verified_at,updated_at) VALUES($1,$2,'disabled',$3,$4,NULL,NULL,$5) ON CONFLICT(organization_id) DO UPDATE SET revision=excluded.revision,state='disabled',credential=NULL,verified_at=NULL,updated_at=excluded.updated_at", [organizationId, result.revision, result.provider, result.maskedEmail, result.updatedAt]);
   await audit(sql, principal, metadata(organizationId, old), result, "disabled"); await authorize(sql, principal, organizationId); return { ...result, profiles: PROFILES.map(profile => ({ ...profile })) };
  });
 }
 async function getSender(sql: SqlExecutor, organizationId: string): Promise<{ from: string; transport: TransactionalEmailTransportPort } | null> {
  text(organizationId, 200); const org = await deps.getOrganization(sql, organizationId); if (!org || org.id !== organizationId || org.status !== "approved") return null;
  const stored = (await sql.query<Stored>(`SELECT ${METADATA_COLUMNS},credential FROM organizer_mail_accounts WHERE organization_id=$1`, [organizationId])).rows[0];
  if (!stored || stored.state !== "verified") return null;
  const config = decrypt(stored); let actual: TransactionalEmailTransportPort;
  try { actual = deps.createSmtpMailTransport(config); } catch { return unavailable(); }
  return { from: config.user, transport: { async send(message, options) {
   if (options.signal.aborted || message.from !== config.user) throw new DomainError("ORGANIZER_MAIL_SENDER_CHANGED", "发信账号已变化或发送已取消，请重新核对当前设置。", { status: 409 });
   // A captured sender cannot outlive disable, replacement or organization suspension.
   await deps.database.transaction(async executor => {
    const currentOrg = await deps.getOrganization(executor, organizationId), current = await read(executor, organizationId);
    if (!currentOrg || currentOrg.id !== organizationId || currentOrg.status !== "approved" || current?.state !== "verified" || current.revision !== stored.revision) throw new DomainError("ORGANIZER_MAIL_SENDER_CHANGED", "发信账号已停用或更新，本次未继续使用旧账号。", { status: 409 });
   });
   try { await actual.send({ ...message, from: config.user }, options); }
   catch { throw new DomainError("ORGANIZER_MAIL_SEND_UNCONFIRMED", "邮件发送结果暂时无法确认，请核对发送记录；系统不会自动重发。", { status: 503 }); }
  } } };
 }
 async function countConfigured(): Promise<number> {
  return deps.database.transaction(async sql => {
   const rows = (await sql.query<{ organization_id: string }>("SELECT organization_id FROM organizer_mail_accounts WHERE state='verified' ORDER BY organization_id LIMIT 5001")).rows;
   if (rows.length > 5000) throw new DomainError("ORGANIZER_MAIL_COUNT_LIMIT", "当前机构数超过一次统计上限，请联系管理员分批核对。", { status: 503 });
   let count = 0; for (const row of rows) { const org = await deps.getOrganization(sql, row.organization_id); if (org?.id === row.organization_id && org.status === "approved") count++; } return count;
  });
 }
 async function principal(request: Request) { const value = await deps.resolvePrincipal(request); if (!value) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 }); return value; }
 async function body(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new DomainError("INVALID_CONTENT_TYPE", "请通过本站表单提交。", { status: 415 });
  const reader = request.body?.getReader(); if (!reader) return invalid(); const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 16384) { await reader.cancel(); throw new DomainError("BODY_TOO_LARGE", "邮箱配置过长，请检查输入。", { status: 413 }); } chunks.push(chunk.value); } } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { return invalid("提交格式无效，请重试。"); }
 }
 return { get, save, disable, getSender, countConfigured, async handle(request: Request, segments: readonly string[]): Promise<Response | null> {
  const route = segments.join("/").match(/^organizer\/organizations\/([^/]+)\/mail-account(\/disable)?$/); if (!route) return null;
  const methods = route[2] ? ["POST"] : ["GET", "PUT"], requestId = deps.ids.next(), headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
  try {
   if (!methods.includes(request.method)) throw new DomainError("METHOD_NOT_ALLOWED", "请通过发信邮箱设置页面操作。", { status: 405 });
   if (request.method !== "GET") await deps.assertMutationAllowed(request); const person = await principal(request), organizationId = text(route[1], 200);
   const data = request.method === "GET" ? await get(person, organizationId) : route[2] ? await disable(person, organizationId, await body(request)) : await save(person, organizationId, await body(request));
   return Response.json({ data, requestId }, { headers });
  } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers: { ...headers, ...(isDomainError(error) && error.status === 405 ? { Allow: methods.join(", ") } : {}) } }); }
 } };
}
export type OrganizerMailAccounts = ReturnType<typeof createOrganizerMailAccounts>;
