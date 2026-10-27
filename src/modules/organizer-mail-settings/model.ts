/** Provider identifiers confirmed by the root mail-account API. */
export const SENDER_PROVIDERS = ["qq", "163", "126", "gmail"] as const;
export type SenderProvider = typeof SENDER_PROVIDERS[number];
export interface SenderAccountDraft { provider: SenderProvider; email: string }
export interface SenderAccountMetadata {
  organizationId: string; revision: number; state: "unconfigured" | "verified" | "disabled";
  provider: SenderProvider | null; maskedEmail: string | null; verifiedAt: string | null; updatedAt: string | null;
  profiles: { id: SenderProvider; label: string; note: string }[];
}
export interface SaveSenderAccountInput { expectedRevision: number; provider: SenderProvider; email: string; authorizationCode: string }
export const SENDER_EMAIL_LIMIT = 254;
export const SENDER_PASSWORD_LIMIT = 4096;
export const senderProviderLabels: Record<SenderProvider, string> = { qq: "QQ 邮箱", "163": "163 邮箱", "126": "126 邮箱", gmail: "Gmail" };
/** Client hints only; provider/SMTP allowlisting and permissions belong to the root. */
export function validateSenderDraft(draft: SenderAccountDraft, password: string): string[] {
  const errors: string[] = [];
  if (!(SENDER_PROVIDERS as readonly string[]).includes(draft.provider)) errors.push("请选择支持的邮箱服务。");
  const email = draft.email.trim();
  if (!email || email.length > SENDER_EMAIL_LIMIT || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email) || /[\u0000-\u001f\u007f]/.test(email)) errors.push("请填写完整的发信邮箱地址。");
  if (!password.trim()) errors.push("请填写邮箱授权码或应用专用密码。");
  if (password.length > SENDER_PASSWORD_LIMIT || /[\u0000-\u001f\u007f]/.test(password)) errors.push("授权码含有不支持的字符或长度，请重新复制。");
  return errors;
}
export function sameSenderDraft(a: SenderAccountDraft, b: SenderAccountDraft): boolean { return a.provider === b.provider && a.email === b.email; }
/** Copy only the confirmed safe projection. Extra response properties never enter UI state. */
export function safeSenderMetadata(value: unknown, organizationId: string): SenderAccountMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("发信设置返回无法读取，请刷新后核对。");
  const item = value as Record<string, unknown>;
  if (item.organizationId !== organizationId || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0 || !["unconfigured", "verified", "disabled"].includes(String(item.state))) throw new Error("发信设置与当前主办方或版本不符，请重新读取。");
  if (item.provider !== null && !(SENDER_PROVIDERS as readonly unknown[]).includes(item.provider)) throw new Error("发信设置包含未支持的邮箱服务，请联系网站管理员。");
  for (const key of ["maskedEmail", "verifiedAt", "updatedAt"] as const) if (item[key] !== null && typeof item[key] !== "string") throw new Error("发信设置返回不完整，请重新读取。");
  if (!Array.isArray(item.profiles)) throw new Error("发信设置返回缺少邮箱服务选项，请重新读取。");
  const profiles = item.profiles.map((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("邮箱服务选项无法读取。");
    const profile = row as Record<string, unknown>;
    if (!(SENDER_PROVIDERS as readonly unknown[]).includes(profile.id) || typeof profile.label !== "string" || typeof profile.note !== "string") throw new Error("邮箱服务选项包含未支持的内容。");
    return { id: profile.id as SenderProvider, label: profile.label, note: profile.note };
  });
  return { organizationId, revision: Number(item.revision), state: item.state as SenderAccountMetadata["state"], provider: item.provider as SenderProvider | null, maskedEmail: item.maskedEmail as string | null, verifiedAt: item.verifiedAt as string | null, updatedAt: item.updatedAt as string | null, profiles };
}
export function prepareSenderAccountInput(expectedRevision: number, draft: SenderAccountDraft, authorizationCode: string): SaveSenderAccountInput {
  const errors = validateSenderDraft(draft, authorizationCode);
  if (errors.length) throw new Error(errors.join(" "));
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("请先读取当前发信设置版本。");
  return { expectedRevision, provider: draft.provider, email: draft.email.trim(), authorizationCode };
}
/** Never render raw SMTP errors: they can contain credentials or addresses. */
export function senderSaveFailureText(failure?: { status: number; code: string }): string {
  if (failure?.code === "ORGANIZER_MAIL_VERIFICATION_FAILED") return "邮箱连接或认证未通过，本次配置未保存，原有设置保留。请按下方官方帮助核对 SMTP 服务与授权码，再读取最新设置重试；完整邮箱已保留，授权码已清除。";
  if (failure?.code === "ORGANIZER_MAIL_VERIFICATION_RATE_LIMIT") return "本次没有发起验证。每家主办方至少间隔 60 秒才能再次验证；请稍后读取最新设置并重新确认。完整邮箱已保留，授权码已清除。";
  if (failure?.code === "ORGANIZER_MAIL_VERIFICATION_DAILY_LIMIT") return "本次没有发起验证。已达到本主办方当前每天 10 次验证上限，请等待下一次北京时间 08:00 的额度重置后再明确提交。完整邮箱已保留，授权码已清除。";
  if (failure?.status === 409) return "发信设置已被更新，请先读取最新版本核对。邮箱服务和完整邮箱已保留，授权码已清除。";
  if (!failure || failure.status >= 500 || /UNKNOWN|TIMEOUT|INVALID_RESPONSE|IN_PROGRESS/.test(failure.code)) return "本次保存结果尚未确认，请先读取最新设置核对。邮箱服务和完整邮箱已保留，授权码已清除；不会自动重试。";
  return "验证或保存未完成，新输入不能视为已启用。请先读取最新设置，再按下方帮助重新填写授权码；邮箱服务和完整邮箱已保留。";
}
