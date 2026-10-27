export const NOTICE_ACCENTS = ["orange", "blue", "green", "slate"] as const;
export const NOTICE_THEMES = ["simple", "letter"] as const;
export type NoticeAccent = typeof NOTICE_ACCENTS[number];
export type NoticeTheme = typeof NOTICE_THEMES[number];
export type NoticeMailState = "unconfigured" | "queued" | "leased" | "sending" | "accepted" | "unknown_hold" | "failed" | "cancelled";

export interface NoticeContent { subject: string; body: string; accent: NoticeAccent; theme: NoticeTheme }
export interface SelectionNoticeTemplate extends NoticeContent {
  eventId: string;
  revision: number;
  /** Server-rendered example; its name is illustrative, never the selected recipient. */
  preview: { subject: string; body: string };
  event?: { title: string; organizationName: string };
}
export interface SelectionNotice extends NoticeContent {
  id: string; eventId: string; registrationId: string; registrationRevision: number;
  version: number; templateRevision: number; publishedAt: string; mailState: NoticeMailState;
}
export interface SelectionNoticeRegistration { id: string; userId: string; revision: number; status: string }
export interface SelectionNoticeList { items: SelectionNotice[]; registrationStatus?: string | null; registrationRevision?: number }
export interface ManagedSelectionNoticeList extends SelectionNoticeList {
  recipient: { userId: string; label: string };
  registrationRevision: number;
  registrationId?: string;
  event?: { title: string; organizationName: string };
  /** A read-only server preview for this exact recipient and saved template. */
  preview?: NoticeContent & { templateRevision: number };
}
export interface PublishSelectionNoticeInput {
  recipientUserId: string; expectedRegistrationRevision: number; templateRevision: number;
  expectedNoticeVersion: number; confirmNewVersion?: true; newOperationKey?: string;
}
export interface SaveSelectionNoticeTemplateInput extends NoticeContent { expectedRevision: number }

export const NOTICE_LIMITS = { subject: 200, body: 12000 } as const;
export const NOTICE_VARIABLES = ["name", "event", "organizer"] as const;

/** Client feedback only; authorization, rendering and CAS remain server responsibilities. */
export function validateNoticeContent(content: NoticeContent): string[] {
  const errors: string[] = [];
  for (const key of ["subject", "body"] as const) {
    const value = content[key], label = key === "subject" ? "标题" : "正文";
    if (!value.trim()) errors.push(`请填写通知${label}。`);
    if (value.length > NOTICE_LIMITS[key]) errors.push(`${label}最多 ${NOTICE_LIMITS[key]} 个字符。`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || key === "subject" && /[\r\n]/.test(value)) errors.push(`${label}含有不支持的控制字符。`);
    if (/[{}]/.test(value.replace(/\{(name|event|organizer)\}/g, ""))) errors.push(`${label}只支持 {name}、{event}、{organizer} 三种变量，请删除其他花括号。`);
  }
  if (!(NOTICE_ACCENTS as readonly string[]).includes(content.accent)) errors.push("请选择提供的强调色。");
  if (!(NOTICE_THEMES as readonly string[]).includes(content.theme)) errors.push("请选择简洁或信函样式。");
  return errors;
}

/** Draft preview stays text. Literal HTML is shown as text, never interpreted. */
export function renderNoticeExample(content: NoticeContent, values: { name: string; event: string; organizer: string }): NoticeContent {
  const replace = (text: string) => text.replace(/\{(name|event|organizer)\}/g, (_, key: keyof typeof values) => values[key]);
  return { ...content, subject: replace(content.subject), body: replace(content.body) };
}
export function sameNoticeContent(a: NoticeContent, b: NoticeContent): boolean {
  return a.subject === b.subject && a.body === b.body && a.accent === b.accent && a.theme === b.theme;
}
export function latestSelectionNotice(items: readonly SelectionNotice[], registration: SelectionNoticeRegistration, eventId: string): SelectionNotice | null {
  return items.filter(item => item.eventId === eventId && item.registrationId === registration.id && item.registrationRevision === registration.revision)
    .reduce<SelectionNotice | null>((latest, item) => !latest || item.version > latest.version ? item : latest, null);
}
export function prepareSelectionNoticeInput(registration: SelectionNoticeRegistration, templateRevision: number, currentVersion: number, newOperationKey?: string): PublishSelectionNoticeInput {
  if (registration.status !== "approved" || !registration.id || !registration.userId || !Number.isSafeInteger(registration.revision) || registration.revision < 1) throw new Error("请先核对本场已通过审核的报名记录。");
  if (!Number.isSafeInteger(templateRevision) || templateRevision < 1) throw new Error("请先保存本场入选通知模板。");
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) throw new Error("请先读取当前通知版本。");
  if (currentVersion > 0 && (!newOperationKey || newOperationKey === "initial" || newOperationKey.length > 100 || /[\s\u0000-\u001f\u007f]/.test(newOperationKey))) throw new Error("新版通知需要独立的确认操作。");
  return { recipientUserId: registration.userId, expectedRegistrationRevision: registration.revision, templateRevision, expectedNoticeVersion: currentVersion,
    ...(currentVersion > 0 ? { confirmNewVersion: true as const, newOperationKey } : {}) };
}
export function mailStateText(state: NoticeMailState): string {
  const labels: Record<NoticeMailState, string> = {
    unconfigured: "邮件未配置", queued: "邮件排队中", leased: "邮件等待发送", sending: "邮件正在处理",
    accepted: "邮件服务已接受，收件与已读未确认", unknown_hold: "邮件结果未知，已暂停自动重发",
    failed: "邮件发送失败", cancelled: "邮件发送已取消"
  };
  return labels[state] ?? "邮件状态待核对";
}
export function currentRegistrationNoticeText(status: string | null | undefined): string {
  const labels: Record<string, string> = { draft: "当前报名仍为草稿", pending: "当前报名等待审核", approved: "当前报名已通过审核", rejected: "当前报名未通过审核", withdrawn: "当前报名已撤回" };
  return status === "approved" ? `${labels[status]}。通知保留发布时内容，比赛安排请继续查看本场官方说明。` : `${status ? labels[status] ?? "当前报名状态待核对" : "当前报名状态待核对"}。历史入选通知只代表发布当时的记录，不表示当前仍具备参赛资格。`;
}
