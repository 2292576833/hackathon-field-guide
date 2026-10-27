import { prepareSelectionNoticeInput, type ManagedSelectionNoticeList, type NoticeContent, type PublishSelectionNoticeInput, type SelectionNotice, type SelectionNoticeRegistration, type SelectionNoticeTemplate } from "./model.ts";
import { latestSelectionNotice } from "./model.ts";

export interface NoticePublicationPreview {
  eventId: string;
  registrationId: string;
  input: PublishSelectionNoticeInput;
  content: NoticeContent;
  recipient: { userId: string; label: string };
  exampleName: boolean;
  currentVersion: number;
}
/** Pins the server facts shown for confirmation, without accepting recipient text for publication. */
export function prepareNoticePublication(eventId: string, registration: SelectionNoticeRegistration, template: SelectionNoticeTemplate, managed: ManagedSelectionNoticeList, newOperationKey?: string): NoticePublicationPreview {
  if (template.eventId !== eventId || managed.recipient.userId !== registration.userId || managed.registrationRevision !== registration.revision || managed.registrationId && managed.registrationId !== registration.id) throw new Error("收件人或报名版本已变化，请重新读取本场记录。");
  const latest = latestSelectionNotice(managed.items, registration, eventId), currentVersion = latest?.version ?? 0;
  if (managed.items.some(item => item.eventId !== eventId || item.registrationId !== registration.id || item.registrationRevision !== registration.revision)) throw new Error("通知列表与当前报名不一致，请重新读取。");
  const preview = managed.preview;
  if (preview && preview.templateRevision !== template.revision) throw new Error("预览模板已变化，请重新读取后核对。");
  return { eventId, registrationId: registration.id, input: prepareSelectionNoticeInput(registration, template.revision, currentVersion, newOperationKey),
    content: preview ? { subject: preview.subject, body: preview.body, accent: preview.accent, theme: preview.theme } : { subject: template.preview.subject, body: template.preview.body, accent: template.accent, theme: template.theme },
    recipient: { ...managed.recipient }, exampleName: !preview, currentVersion };
}

export type NoticePublicationState = "ready" | "sending" | "unknown" | "rejected" | "published";
/** One explicit publication owns one immutable input. Retries cannot adopt a new key or template. */
export class NoticePublicationAttempt {
  readonly preview: NoticePublicationPreview;
  state: NoticePublicationState = "ready";
  receipt: SelectionNotice | null = null;
  constructor(preview: NoticePublicationPreview) {
    this.preview = { ...preview, input: Object.freeze({ ...preview.input }), content: Object.freeze({ ...preview.content }), recipient: Object.freeze({ ...preview.recipient }) };
  }
  async send(publish: (input: PublishSelectionNoticeInput) => Promise<SelectionNotice>, unknownOutcome: (reason: unknown) => boolean): Promise<SelectionNotice> {
    if (this.state === "sending") throw new Error("当前发布仍在处理，请稍候。");
    if (this.receipt) return this.receipt;
    this.state = "sending";
    try {
      const receipt = await publish(this.preview.input);
      if (receipt.eventId !== this.preview.eventId || receipt.registrationId !== this.preview.registrationId || receipt.templateRevision !== this.preview.input.templateRevision || receipt.registrationRevision !== this.preview.input.expectedRegistrationRevision || receipt.version !== this.preview.currentVersion + 1) {
        this.state = "unknown"; throw new Error("发布返回的版本与本次确认不符，请读取最新通知核对。");
      }
      this.receipt = receipt; this.state = "published"; return receipt;
    } catch (reason) { if (this.state !== "unknown") this.state = unknownOutcome(reason) ? "unknown" : "rejected"; throw reason; }
  }
}
