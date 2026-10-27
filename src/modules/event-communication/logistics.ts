import { createHash, randomBytes } from "node:crypto";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { parseEventInstant } from "./validation.ts";
import type {
  AccommodationAssignment, AccommodationFields, AccommodationImportPreview, AccommodationImportRow,
  AssignAccommodationInput, ConfirmAccommodationImportResult, CreateVoucherTypeInput, IssueVoucherInput,
  IssueVoucherResult, LogisticsDependencies, MealVoucher, OwnEventServices, RedeemVoucherInput,
  RedeemVoucherResult, RevokeVoucherInput, VoucherRedemption, VoucherType,
} from "./logistics-model.ts";

function invalid(message = "请检查填写内容。") : never { throw new DomainError("LOGISTICS_INVALID_INPUT", message); }
function denied(): never { throw new DomainError("FORBIDDEN", "当前身份不能查看或操作这项现场服务。", { status: 403 }); }
function missing(): never { throw new DomainError("LOGISTICS_NOT_FOUND", "此赛事中没有这条记录。", { status: 404 }); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid("包含不支持的字段，请刷新页面。 ");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200, optional = false): string {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max || /\u0000/.test(value)) return invalid();
  return value.trim();
}
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid("版本无效，请重新读取。"); return value as number; }
function sameRevision(expected: number, actual: number): void {
  if (expected !== actual) throw new DomainError("VERSION_CONFLICT", "安排已更新，请重新读取后确认；本页输入已保留。", { status: 409, latestRevision: actual });
}
function instant(value: unknown): string {
  return parseEventInstant(value, "LOGISTICS_INVALID_INPUT");
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fingerprint(parts: readonly unknown[]): string { return hash(JSON.stringify(parts)); }
function accommodation(value: unknown): AccommodationFields {
  const body = object(value, ["userId", "location", "room", "checkIn", "checkOut", "note", "expectedRevision"]);
  const checkIn = instant(body.checkIn), checkOut = instant(body.checkOut);
  if (checkIn >= checkOut) return invalid("离店时间须晚于入住时间。");
  return { userId: text(body.userId), location: text(body.location, 200), room: text(body.room, 100), checkIn, checkOut, note: text(body.note, 1000, true) };
}

/** Bounded RFC4180-style CSV. No executable formula evaluation or file parsing. */
function csvRows(value: unknown): string[][] {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 256_000 || /\u0000/.test(value)) return invalid("请粘贴不超过 256KB 的 CSV 文本。");
  const csv = value.replace(/^\uFEFF/, ""), rows: string[][] = [], row: string[] = [];
  let cell = "", quoted = false, closed = false;
  function endCell() { row.push(cell); cell = ""; closed = false; }
  function endRow() { endCell(); if (row.some(v => v !== "")) rows.push([...row]); row.length = 0; if (rows.length > 501) return invalid("每次最多预览 500 人，请分批导入。"); }
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"') { if (csv[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += ch;
    } else if (ch === '"') { if (cell || closed) return invalid("CSV 引号格式有误。"); quoted = true; }
    else if (ch === ",") endCell();
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && csv[i + 1] === "\n") i++; endRow(); }
    else { if (closed) return invalid("CSV 引号后的内容有误。"); cell += ch; }
  }
  if (quoted) return invalid("CSV 引号没有闭合。");
  if (cell || row.length || closed) endRow();
  return rows;
}
type VoucherRow = { document: MealVoucher; remaining_uses: number; revision: number; revoked_at: string | Date | null; revoked_by: string | null; expires_at: string | Date };

/** All persistence belongs to ec_ tables. Account/session and cross-module facts use transaction-scoped Ports. */
export function createEventLogisticsService(deps: LogisticsDependencies) {
  const now = () => deps.clock.now().toISOString();
  async function approved(sql: SqlExecutor, eventId: string, userId: string) {
    const registration = await deps.participation.getRegistration(sql, eventId, userId);
    if (!registration || registration.eventId !== eventId || registration.userId !== userId || registration.status !== "approved") return denied();
  }
  async function scope(sql: SqlExecutor, principal: OrganizerPrincipal, eventId: string, staff: boolean, write: boolean, module?: "accommodation" | "mealVouchers") {
    text(eventId); await principal.guard(sql);
    const event = await deps.eventAccess.getEvent(sql, eventId, { forUpdate: write });
    if (!event) return missing();
    if (event.eventId !== eventId) return denied();
    if (staff) {
      const permitted = await deps.eventAccess.requireStaff(sql, principal.actor, eventId, "logistics_manage");
      if (permitted.eventId !== eventId || permitted.organizationId !== event.organizationId) return denied();
    } else {
      if (!["published", "ended", "archived"].includes(event.status) || event.publishedRevision === null) return missing();
      await approved(sql, eventId, principal.actor.userId);
    }
    if (write) {
      if (event.status === "archived") throw new DomainError("EVENT_READ_ONLY", "赛事已归档，只能查看历史。", { status: 409 });
      if (module && !event.modules[module]) throw new DomainError("EVENT_MODULE_DISABLED", "主办方已关闭这项现场服务，历史记录仍可查看。", { status: 409 });
    }
    return event;
  }
  async function run<T>(principal: OrganizerPrincipal, eventId: string, staff: boolean, write: boolean, module: "accommodation" | "mealVouchers" | undefined,
    work: (sql: SqlExecutor, event: HostedEventScope, checkRecipient: (userId: string) => Promise<void>) => Promise<T>): Promise<T> {
    return deps.database.transaction(async sql => {
      const event = await scope(sql, principal, eventId, staff, write, module), recipients = new Set<string>();
      const checkRecipient = async (userId: string) => { await approved(sql, eventId, userId); recipients.add(userId); };
      const result = await work(sql, event, checkRecipient);
      const current = await scope(sql, principal, eventId, staff, write, module);
      if (event.organizationId !== current.organizationId) return denied();
      for (const userId of recipients) await approved(sql, eventId, userId);
      return result;
    });
  }
  async function getAccommodation(sql: SqlExecutor, event: HostedEventScope, userId: string): Promise<AccommodationAssignment | null> {
    const result = await sql.query<{ document: AccommodationAssignment }>("SELECT document FROM ec_accommodation_assignments WHERE organization_id=$1 AND event_id=$2 AND user_id=$3 FOR UPDATE", [event.organizationId, event.eventId, userId]);
    return result.rows[0]?.document ?? null;
  }
  async function saveAccommodation(sql: SqlExecutor, event: HostedEventScope, principal: OrganizerPrincipal, fields: AccommodationFields, expected: number): Promise<AccommodationAssignment> {
    const old = await getAccommodation(sql, event, fields.userId); sameRevision(expected, old?.revision ?? 0);
    const next: AccommodationAssignment = { ...fields, id: old?.id ?? deps.ids.next(), eventId: event.eventId, revision: expected + 1, updatedAt: now(), updatedBy: principal.actor.userId };
    if (old) {
      const changed = await sql.query("UPDATE ec_accommodation_assignments SET document=$1,revision=$2 WHERE organization_id=$3 AND event_id=$4 AND user_id=$5 AND revision=$6", [JSON.stringify(next), next.revision, event.organizationId, event.eventId, fields.userId, expected]);
      if (changed.rowCount !== 1) sameRevision(expected, (await getAccommodation(sql, event, fields.userId))?.revision ?? 0);
    } else await sql.query("INSERT INTO ec_accommodation_assignments(id,organization_id,event_id,user_id,revision,document) VALUES($1,$2,$3,$4,$5,$6)", [next.id, event.organizationId, event.eventId, fields.userId, next.revision, JSON.stringify(next)]);
    await sql.query("INSERT INTO ec_accommodation_versions(organization_id,event_id,assignment_id,revision,document) VALUES($1,$2,$3,$4,$5)", [event.organizationId, event.eventId, next.id, next.revision, JSON.stringify(next)]);
    return next;
  }
  function voucherView(row: VoucherRow): MealVoucher {
    const expiresAt = new Date(row.expires_at).toISOString(), revokedAt = row.revoked_at === null ? null : new Date(row.revoked_at).toISOString();
    return { ...row.document, remainingUses: row.remaining_uses, revision: row.revision, expiresAt, revokedAt, revokedBy: row.revoked_by,
      state: revokedAt !== null ? "revoked" : expiresAt <= now() ? "expired" : row.remaining_uses === 0 ? "exhausted" : "available" };
  }
  async function getVoucher(sql: SqlExecutor, event: HostedEventScope, target: { id?: string; hash?: string }): Promise<MealVoucher> {
    const result = await sql.query<VoucherRow>(`SELECT document,remaining_uses,revision,revoked_at,revoked_by,expires_at FROM ec_meal_vouchers WHERE organization_id=$1 AND event_id=$2 AND ${target.id ? "id" : "token_hash"}=$3 FOR UPDATE`, [event.organizationId, event.eventId, target.id ?? target.hash]);
    if (!result.rows[0]) return missing(); return voucherView(result.rows[0]);
  }
  async function listVouchers(sql: SqlExecutor, event: HostedEventScope, userId?: string): Promise<MealVoucher[]> {
    const rows = await sql.query<VoucherRow>("SELECT document,remaining_uses,revision,revoked_at,revoked_by,expires_at FROM ec_meal_vouchers WHERE organization_id=$1 AND event_id=$2 AND ($3::text IS NULL OR user_id=$3) ORDER BY id LIMIT 500", [event.organizationId, event.eventId, userId ?? null]);
    return rows.rows.map(voucherView);
  }
  async function saveVoucherVersion(sql: SqlExecutor, event: HostedEventScope, principal: OrganizerPrincipal, voucher: MealVoucher, action: string) {
    await sql.query("INSERT INTO ec_voucher_versions(organization_id,event_id,voucher_id,revision,action,operator_user_id,document) VALUES($1,$2,$3,$4,$5,$6,$7)", [event.organizationId, event.eventId, voucher.id, voucher.revision, action, principal.actor.userId, JSON.stringify(voucher)]);
  }
  return {
    async listAccommodation(principal: OrganizerPrincipal, eventId: string): Promise<AccommodationAssignment[]> {
      return run(principal, eventId, true, false, undefined, async (sql, event) => (await sql.query<{ document: AccommodationAssignment }>("SELECT document FROM ec_accommodation_assignments WHERE organization_id=$1 AND event_id=$2 ORDER BY user_id LIMIT 500", [event.organizationId, eventId])).rows.map(row => row.document));
    },
    async assignAccommodation(principal: OrganizerPrincipal, eventId: string, input: AssignAccommodationInput): Promise<AccommodationAssignment> {
      const fields = accommodation(input), expected = revision(input.expectedRevision);
      return run(principal, eventId, true, true, "accommodation", async (sql, event, check) => { await check(fields.userId); return saveAccommodation(sql, event, principal, fields, expected); });
    },
    async previewAccommodationImport(principal: OrganizerPrincipal, eventId: string, input: { readonly csv: string }): Promise<AccommodationImportPreview> {
      const body = object(input, ["csv"]), rows = csvRows(body.csv);
      const headers = ["userId", "location", "room", "checkIn", "checkOut", "note"];
      if (JSON.stringify(rows[0]) !== JSON.stringify(headers)) return invalid("表头须为 userId,location,room,checkIn,checkOut,note。");
      if (rows.length < 2) return invalid("请至少填写一位已通过报名的选手。");
      return run(principal, eventId, true, true, "accommodation", async (sql, event, check) => {
        const valid: AccommodationImportRow[] = [], errors: { line: number; message: string }[] = [], seen = new Set<string>();
        for (let index = 1; index < rows.length; index++) {
          const line = index + 1, cells = rows[index]!;
          let fields: AccommodationFields;
          try {
            if (cells.length !== headers.length) return invalid("CSV 每行须有六列。");
            fields = accommodation(Object.fromEntries(headers.map((key, i) => [key, cells[i]])));
            if (seen.has(fields.userId)) return invalid("同一选手不能在一次导入中出现两次。");
            seen.add(fields.userId);
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            errors.push({ line, message: error.message }); continue;
          }
          const registration = await deps.participation.getRegistration(sql, eventId, fields.userId);
          if (!registration || registration.eventId !== eventId || registration.userId !== fields.userId || registration.status !== "approved") { errors.push({ line, message: "此选手尚未通过本赛事报名。" }); continue; }
          await check(fields.userId);
          const old = await getAccommodation(sql, event, fields.userId);
          valid.push({ ...fields, line, expectedRevision: old?.revision ?? 0 });
        }
        const preview: AccommodationImportPreview = { id: deps.ids.next(), eventId, createdBy: principal.actor.userId, createdAt: now(), expiresAt: new Date(deps.clock.now().getTime() + 30 * 60_000).toISOString(), rows: valid, errors, state: "preview", assignments: [] };
        await sql.query("INSERT INTO ec_accommodation_imports(id,organization_id,event_id,user_id,state,document) VALUES($1,$2,$3,$4,$5,$6)", [preview.id, event.organizationId, eventId, principal.actor.userId, preview.state, JSON.stringify(preview)]);
        return preview;
      });
    },
    async confirmAccommodationImport(principal: OrganizerPrincipal, eventId: string, input: { readonly previewId: string }): Promise<ConfirmAccommodationImportResult> {
      const body = object(input, ["previewId"]), id = text(body.previewId);
      return run(principal, eventId, true, true, "accommodation", async (sql, event, check) => {
        const result = await sql.query<{ document: AccommodationImportPreview }>("SELECT document FROM ec_accommodation_imports WHERE organization_id=$1 AND event_id=$2 AND id=$3 AND user_id=$4 FOR UPDATE", [event.organizationId, eventId, id, principal.actor.userId]);
        const preview = result.rows[0]?.document; if (!preview) return missing();
        for (const row of preview.rows) await check(row.userId);
        if (preview.state === "confirmed") return { previewId: id, assignments: preview.assignments, replayed: true };
        if (preview.errors.length) return invalid("预览中有错误，请修正 CSV 后重新预览。未写入任何分配。");
        if (preview.expiresAt <= now()) throw new DomainError("IMPORT_EXPIRED", "预览已过期，请重新预览。", { status: 409 });
        // Check all versions before any write; transaction also rolls back on final permission failure.
        for (const row of preview.rows) sameRevision(row.expectedRevision, (await getAccommodation(sql, event, row.userId))?.revision ?? 0);
        const assignments: AccommodationAssignment[] = [];
        for (const row of preview.rows) {
          const { line: _line, expectedRevision: expected, ...fields } = row;
          assignments.push(await saveAccommodation(sql, event, principal, fields, expected));
        }
        const next: AccommodationImportPreview = { ...preview, state: "confirmed", assignments };
        await sql.query("UPDATE ec_accommodation_imports SET state='confirmed',document=$1 WHERE organization_id=$2 AND event_id=$3 AND id=$4 AND user_id=$5", [JSON.stringify(next), event.organizationId, eventId, id, principal.actor.userId]);
        return { previewId: id, assignments, replayed: false };
      });
    },
    async createVoucherType(principal: OrganizerPrincipal, eventId: string, input: CreateVoucherTypeInput): Promise<VoucherType> {
      const body = object(input, ["name", "uses", "expiresAt"]), name = text(body.name, 100), expiresAt = instant(body.expiresAt);
      if (!Number.isSafeInteger(body.uses) || (body.uses as number) < 1 || (body.uses as number) > 100) return invalid("每张券可使用 1 至 100 次。");
      return run(principal, eventId, true, true, "mealVouchers", async (sql, event) => {
        if (expiresAt <= now()) return invalid("有效期须晚于当前时间。");
        const type: VoucherType = { id: deps.ids.next(), eventId, name, uses: body.uses as number, expiresAt, createdAt: now(), createdBy: principal.actor.userId };
        await sql.query("INSERT INTO ec_voucher_types(id,organization_id,event_id,document) VALUES($1,$2,$3,$4)", [type.id, event.organizationId, eventId, JSON.stringify(type)]); return type;
      });
    },
    async listVoucherTypes(principal: OrganizerPrincipal, eventId: string): Promise<VoucherType[]> {
      return run(principal, eventId, true, false, undefined, async (sql, event) => (await sql.query<{ document: VoucherType }>("SELECT document FROM ec_voucher_types WHERE organization_id=$1 AND event_id=$2 ORDER BY id LIMIT 100", [event.organizationId, eventId])).rows.map(row => row.document));
    },
    async listVouchers(principal: OrganizerPrincipal, eventId: string, input: { readonly userId?: string } = {}): Promise<MealVoucher[]> {
      const body = object(input, ["userId"]), userId = body.userId === undefined ? undefined : text(body.userId);
      return run(principal, eventId, true, false, undefined, (sql, event) => listVouchers(sql, event, userId));
    },
    async issueVoucher(principal: OrganizerPrincipal, eventId: string, input: IssueVoucherInput): Promise<IssueVoucherResult> {
      const body = object(input, ["userId", "typeId", "idempotencyKey"]), userId = text(body.userId), typeId = text(body.typeId), key = text(body.idempotencyKey, 120), bound = fingerprint([userId, typeId]);
      return run(principal, eventId, true, true, "mealVouchers", async (sql, event, check) => {
        await check(userId);
        const previous = (await sql.query<{ fingerprint: string; voucher_id: string }>("SELECT fingerprint,voucher_id FROM ec_voucher_issues WHERE organization_id=$1 AND event_id=$2 AND operator_user_id=$3 AND idempotency_key=$4 FOR UPDATE", [event.organizationId, eventId, principal.actor.userId, key])).rows[0];
        if (previous) {
          if (previous.fingerprint !== bound) throw new DomainError("IDEMPOTENCY_CONFLICT", "这次发放编号已用于其他输入，请核对后重试。", { status: 409 });
          return { voucher: await getVoucher(sql, event, { id: previous.voucher_id }), token: null, replayed: true };
        }
        const type = (await sql.query<{ document: VoucherType }>("SELECT document FROM ec_voucher_types WHERE organization_id=$1 AND event_id=$2 AND id=$3 FOR UPDATE", [event.organizationId, eventId, typeId])).rows[0]?.document;
        if (!type) return missing(); if (type.expiresAt <= now()) throw new DomainError("VOUCHER_EXPIRED", "该餐券类型已过期，请新建有效的类型。", { status: 409 });
        const token = deps.tokens?.generate() ?? randomBytes(32).toString("base64url");
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new DomainError("TOKEN_GENERATION_FAILED", "无法生成餐券，请稍后重试。", { status: 503 });
        const voucher: MealVoucher = { id: deps.ids.next(), eventId, userId, typeId, name: type.name, totalUses: type.uses, remainingUses: type.uses, expiresAt: type.expiresAt, issuedAt: now(), issuedBy: principal.actor.userId, revokedAt: null, revokedBy: null, revision: 1, state: "available" };
        await sql.query("INSERT INTO ec_meal_vouchers(id,organization_id,event_id,user_id,type_id,token_hash,total_uses,remaining_uses,expires_at,revoked_at,revoked_by,revision,document) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,NULL,NULL,1,$9)", [voucher.id, event.organizationId, eventId, userId, typeId, hash(token), type.uses, type.expiresAt, JSON.stringify(voucher)]);
        await sql.query("INSERT INTO ec_voucher_issues(organization_id,event_id,operator_user_id,idempotency_key,fingerprint,voucher_id) VALUES($1,$2,$3,$4,$5,$6)", [event.organizationId, eventId, principal.actor.userId, key, bound, voucher.id]);
        await saveVoucherVersion(sql, event, principal, voucher, "issued");
        return { voucher, token, replayed: false };
      });
    },
    async revokeVoucher(principal: OrganizerPrincipal, eventId: string, input: RevokeVoucherInput): Promise<MealVoucher> {
      const body = object(input, ["voucherId", "expectedRevision"]), id = text(body.voucherId), expected = revision(body.expectedRevision);
      return run(principal, eventId, true, true, "mealVouchers", async (sql, event) => {
        const current = await getVoucher(sql, event, { id }); sameRevision(expected, current.revision);
        if (current.revokedAt !== null) return current;
        const next: MealVoucher = { ...current, revokedAt: now(), revokedBy: principal.actor.userId, revision: current.revision + 1, state: "revoked" };
        await sql.query("UPDATE ec_meal_vouchers SET revoked_at=$1,revoked_by=$2,revision=$3,document=$4 WHERE organization_id=$5 AND event_id=$6 AND id=$7 AND revision=$8", [next.revokedAt, next.revokedBy, next.revision, JSON.stringify(next), event.organizationId, eventId, id, expected]);
        await saveVoucherVersion(sql, event, principal, next, "revoked"); return next;
      });
    },
    async redeemVoucher(principal: OrganizerPrincipal, eventId: string, input: RedeemVoucherInput): Promise<RedeemVoucherResult> {
      const body = object(input, ["token", "voucherId", "idempotencyKey"]), key = text(body.idempotencyKey, 120);
      if ((body.token !== undefined) === (body.voucherId !== undefined)) return invalid("请选择扫码餐券或人工券号其中一种。");
      const mode = body.token === undefined ? "manual" as const : "token" as const;
      const id = mode === "manual" ? text(body.voucherId) : undefined, tokenHash = mode === "token" ? hash(text(body.token, 256)) : undefined;
      const bound = fingerprint([mode, id ?? tokenHash]);
      return run(principal, eventId, true, true, "mealVouchers", async (sql, event, check) => {
        const previous = (await sql.query<{ fingerprint: string; document: VoucherRedemption }>("SELECT fingerprint,document FROM ec_voucher_redemptions WHERE organization_id=$1 AND event_id=$2 AND operator_user_id=$3 AND idempotency_key=$4 FOR UPDATE", [event.organizationId, eventId, principal.actor.userId, key])).rows[0];
        if (previous && previous.fingerprint !== bound) throw new DomainError("IDEMPOTENCY_CONFLICT", "这次核销编号已用于其他餐券，请核对后重试。", { status: 409 });
        const current = await getVoucher(sql, event, { id, hash: tokenHash }); await check(current.userId);
        if (previous) return { receipt: previous.document, replayed: true };
        if (current.state !== "available") throw new DomainError(`VOUCHER_${current.state.toUpperCase()}`, current.state === "expired" ? "餐券已过期。" : current.state === "revoked" ? "餐券已撤销。" : "餐券次数已用完。", { status: 409 });
        const next: MealVoucher = { ...current, remainingUses: current.remainingUses - 1, revision: current.revision + 1, state: current.remainingUses === 1 ? "exhausted" : "available" };
        const updated = await sql.query("UPDATE ec_meal_vouchers SET remaining_uses=remaining_uses-1,revision=revision+1,document=$1 WHERE organization_id=$2 AND event_id=$3 AND id=$4 AND revision=$5 AND remaining_uses>0 AND revoked_at IS NULL AND expires_at>$6", [JSON.stringify(next), event.organizationId, eventId, current.id, current.revision, now()]);
        if (updated.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "餐券已变化，请核对最新状态。", { status: 409, latestRevision: (await getVoucher(sql, event, { id: current.id })).revision });
        const receipt: VoucherRedemption = { id: deps.ids.next(), eventId, voucherId: current.id, operatorUserId: principal.actor.userId, mode, redeemedAt: now(), remainingUses: next.remainingUses, voucherRevision: next.revision };
        await sql.query("INSERT INTO ec_voucher_redemptions(id,organization_id,event_id,operator_user_id,idempotency_key,fingerprint,voucher_id,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [receipt.id, event.organizationId, eventId, principal.actor.userId, key, bound, current.id, JSON.stringify(receipt)]);
        await saveVoucherVersion(sql, event, principal, next, "redeemed"); return { receipt, replayed: false };
      });
    },
    async ownServices(principal: OrganizerPrincipal, eventId: string): Promise<OwnEventServices> {
      return run(principal, eventId, false, false, undefined, async (sql, event) => ({ eventId, modules: { accommodation: event.modules.accommodation, mealVouchers: event.modules.mealVouchers }, accommodation: await getAccommodation(sql, event, principal.actor.userId), vouchers: await listVouchers(sql, event, principal.actor.userId) }));
    },
  };
}
export type EventLogisticsService = ReturnType<typeof createEventLogisticsService>;
