import { documentDraftKey, emptyDocumentDraft, type DocumentDraft, type DocumentDraftCollection, type DraftPublication, type DraftPublicationOutcome, type SaveDocumentDraft, type StartDraftPublication } from "./model.ts";

export interface DraftProtectionTransport {
  list(): Promise<DocumentDraftCollection>;
  get(documentId: string | null): Promise<DocumentDraft>;
  save(documentId: string | null, input: SaveDocumentDraft): Promise<DocumentDraft>;
  remove(documentId: string | null, expectedRevision: number): Promise<DocumentDraft>;
  publish(documentId: string | null, input: StartDraftPublication): Promise<DraftPublicationOutcome>;
  receipt(attemptId: string): Promise<DraftPublication | null>;
}
export interface ProtectedDraftEntry {
  readonly documentId: string | null;
  readonly body: string;
  readonly baseDocumentRevision: number | null;
  readonly server: DocumentDraft;
  readonly editing: boolean;
  readonly dirty: boolean;
  readonly publishing: boolean;
  readonly status: "idle" | "dirty" | "protecting" | "protected" | "error" | "conflict";
  readonly error: string;
  readonly conflict: DocumentDraft | null;
}
interface Entry extends ProtectedDraftEntry { version: number; continuePublicationAttemptId?: string }
export interface DraftProtectionView {
  readonly readOnly: boolean;
  readonly phase: "loading" | "ready" | "load-error" | "blocked";
  readonly error: string;
  readonly entries: readonly ProtectedDraftEntry[];
}
interface DraftProtectionOptions { ownerId: string; projectId: string; transport: DraftProtectionTransport; debounceMs?: number; attemptId?: () => string }
const info = (reason: unknown) => {
  const value = reason as { status?: number; code?: string; message?: string } | null;
  return { status: value?.status, code: value?.code, message: typeof value?.message === "string" ? value.message : "私人草稿保护失败，本页输入仍保留。" };
};
const isHeld = (entry: ProtectedDraftEntry) => ["pending", "unknown"].includes(entry.server.publication?.status ?? "");

/** No browser storage: identity-isolated, server-backed CAS with serialized debounce. */
export class DraftProtection {
  private entries = new Map<string, Entry>();
  private phase: DraftProtectionView["phase"] = "loading";
  private error = "";
  private writable = true;
  private disposed = false;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  private listeners = new Set<(view: DraftProtectionView) => void>();
  private readonly options: DraftProtectionOptions;
  constructor(options: DraftProtectionOptions) {
    this.options = options;
    this.entry(null);
  }
  private entry(documentId: string | null): Entry {
    const key = documentDraftKey(documentId), existing = this.entries.get(key);
    if (existing) return existing;
    const entry: Entry = { documentId, body: "", baseDocumentRevision: null,
      server: emptyDocumentDraft(this.options.ownerId, this.options.projectId, documentId), editing: false,
      dirty: false, publishing: false, status: "idle", error: "", conflict: null, version: 0 };
    this.entries.set(key, entry); return entry;
  }
  private update(entry: Entry, changes: Partial<Entry>) { Object.assign(entry, changes); }
  private alive(epoch: number) { return !this.disposed && this.epoch === epoch; }
  private assertOwner(draft: DocumentDraft) {
    if (draft.ownerId !== this.options.ownerId || draft.projectId !== this.options.projectId) {
      this.block("草稿身份已改变，请重新打开当前账号的空间。"); throw new Error("私人草稿身份不匹配。");
    }
  }
  private emit() { if (!this.disposed) { const view = this.snapshot(); for (const listener of this.listeners) listener(view); } }
  snapshot(): DraftProtectionView { return { phase: this.phase, readOnly: !this.writable, error: this.error, entries: [...this.entries.values()].map(entry => ({ ...entry })) }; }
  subscribe(listener: (view: DraftProtectionView) => void) { this.listeners.add(listener); listener(this.snapshot()); return () => { this.listeners.delete(listener); }; }
  setWritable(writable: boolean) { if (this.writable === writable) return; this.writable = writable; if (!writable) this.cancelTimer(); else this.schedule(); this.emit(); }
  block(message = "当前账号或空间权限已失效，私人输入已隐藏。") {
    this.epoch++; this.cancelTimer(); this.phase = "blocked"; this.error = message; this.entries.clear(); this.emit();
  }
  dispose() { this.disposed = true; this.epoch++; this.cancelTimer(); this.listeners.clear(); }
  private cancelTimer() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private failure(entry: Entry | null, reason: unknown) {
    const failure = info(reason);
    if (failure.status === 401 || failure.status === 403) { this.block(failure.message); return; }
    if (failure.code === "PROJECT_ARCHIVED" || failure.code === "PROJECT_READ_ONLY") { this.writable = false; this.cancelTimer(); }
    if (entry) this.update(entry, { status: "error", error: `私人草稿尚未确认保护：${failure.message}`, dirty: true, publishing: false });
    else { this.phase = "load-error"; this.error = `私人草稿读取失败：${failure.message}`; }
    this.emit();
  }
  private merge(entry: Entry, server: DocumentDraft) {
    this.assertOwner(server);
    if (entry.dirty && server.body !== null && (entry.body !== server.body || entry.baseDocumentRevision !== server.baseDocumentRevision)) {
      this.update(entry, { server, conflict: server, status: "conflict", error: "另一窗口有已保护私稿。本页输入仍保留，请选择恢复或明确覆盖私稿。" });
    } else if (entry.dirty) {
      this.update(entry, { server, status: "dirty", conflict: null, error: "" });
    } else if (server.body !== null) {
      this.update(entry, { server, body: server.body, baseDocumentRevision: server.baseDocumentRevision, editing: true, status: "protected", conflict: null, error: "" });
    } else {
      this.update(entry, { server, conflict: null, error: "" });
    }
  }
  async load(): Promise<void> {
    if (this.disposed || this.phase === "blocked") return;
    if (this.loading) return this.loading;
    const epoch = this.epoch;
    this.phase = "loading"; this.error = ""; this.emit();
    const run = async () => {
      try {
        const saved = await this.options.transport.list(); if (!this.alive(epoch)) return;
        if (saved.ownerId !== this.options.ownerId || saved.projectId !== this.options.projectId) { this.block("草稿身份已改变，已隐藏旧输入。"); return; }
        const keys = new Set<string>();
        for (const draft of saved.items) { this.assertOwner(draft); keys.add(documentDraftKey(draft.documentId)); this.merge(this.entry(draft.documentId), draft); }
        for (const entry of this.entries.values()) if (!keys.has(documentDraftKey(entry.documentId))) this.merge(entry, emptyDocumentDraft(this.options.ownerId, this.options.projectId, entry.documentId));
        this.phase = "ready"; this.emit(); this.schedule();
      } catch (reason) { if (this.alive(epoch)) this.failure(null, reason); }
    };
    this.loading = run().finally(() => { this.loading = null; }); return this.loading;
  }
  edit(documentId: string, originalBody: string, revision: number) {
    if (this.disposed || this.phase === "blocked") return;
    const entry = this.entry(documentId);
    if (entry.server.body === null && !entry.dirty) this.update(entry, { body: originalBody, baseDocumentRevision: revision });
    this.update(entry, { editing: true }); this.emit();
  }
  showTeam(documentId: string) { if (this.disposed || this.phase === "blocked") return; const entry = this.entry(documentId); this.update(entry, { editing: false }); this.emit(); }
  rebase(documentId: string | null, revision: number) {
    if (this.disposed || this.phase === "blocked") return;
    const entry = this.entry(documentId);
    if (!this.writable || entry.publishing || this.phase !== "ready") return;
    this.update(entry, { baseDocumentRevision: revision, dirty: true, version: entry.version + 1, status: entry.conflict ? "conflict" : "dirty" }); this.emit(); this.schedule();
  }
  change(documentId: string | null, body: string) {
    if (this.disposed || this.phase === "blocked" || !this.writable) return;
    const entry = this.entry(documentId); if (entry.publishing) return;
    this.update(entry, { body, editing: true, version: entry.version + 1, dirty: true,
      status: entry.conflict ? "conflict" : "dirty", error: entry.conflict ? entry.error : "" });
    this.emit(); this.schedule();
  }
  private schedule() {
    this.cancelTimer();
    if (this.disposed || !this.writable || this.phase !== "ready") return;
    if (![...this.entries.values()].some(entry => entry.dirty && !["conflict", "error"].includes(entry.status))) return;
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, this.options.debounceMs ?? 650);
  }
  private async drain(): Promise<void> {
    if (this.running) return this.running;
    if (this.disposed || !this.writable || this.phase !== "ready") return;
    const epoch = this.epoch;
    const run = async () => {
      while (this.alive(epoch) && this.writable && this.phase === "ready") {
        const entry = [...this.entries.values()].find(candidate => candidate.dirty && !["conflict", "error"].includes(candidate.status));
        if (!entry) return;
        const version = entry.version, content = entry.body, base = entry.baseDocumentRevision;
        this.update(entry, { status: "protecting", error: "" }); this.emit();
        try {
          const saved = await this.options.transport.save(entry.documentId, { expectedOwnerId: this.options.ownerId, expectedRevision: entry.server.revision, body: content, baseDocumentRevision: base,
            ...(entry.continuePublicationAttemptId ? { continuePublicationAttemptId: entry.continuePublicationAttemptId } : {}) });
          if (!this.alive(epoch)) return; this.assertOwner(saved);
          if (saved.documentId !== entry.documentId || saved.body !== content || saved.baseDocumentRevision !== base) throw new Error("服务没有确认原输入，私稿未确认保护。");
          this.update(entry, { server: saved, conflict: null, error: "", continuePublicationAttemptId: undefined, dirty: entry.version !== version, status: entry.version === version ? "protected" : "dirty" });
          this.emit();
        } catch (reason) {
          if (!this.alive(epoch)) return;
          if (info(reason).code === "VERSION_CONFLICT") {
            try {
              const latest = await this.options.transport.get(entry.documentId); if (!this.alive(epoch)) return; this.assertOwner(latest);
              if (entry.documentId === null && latest.body === null && latest.publication?.status === "succeeded" && latest.publication.result
                && latest.publication.attemptId === entry.server.publication?.attemptId && isHeld(entry)) {
                this.update(entry, { continuePublicationAttemptId: latest.publication.attemptId, baseDocumentRevision: latest.publication.result.documentRevision });
              }
              this.update(entry, { server: latest, conflict: latest, status: "conflict", dirty: true,
                error: "另一窗口已更新私稿，本页输入仍保留。请恢复已保护稿，或明确覆盖私稿。" }); this.emit();
            } catch (failure) { if (this.alive(epoch)) this.failure(entry, failure); }
          } else this.failure(entry, reason);
        }
      }
    };
    this.running = run().finally(() => { this.running = null; }); return this.running;
  }
  async flush(documentId: string | null): Promise<boolean> {
    this.cancelTimer(); await this.loading; await this.running;
    if (!this.writable || this.phase !== "ready" || this.disposed) return false;
    await this.drain(); if (this.disposed || this.phase !== "ready") return false; const entry = this.entry(documentId);
    return !entry.dirty && !["error", "conflict"].includes(entry.status);
  }
  async resolve(documentId: string | null, choice: "restore" | "keep") {
    if (this.disposed || this.phase === "blocked") return;
    const entry = this.entry(documentId), epoch = this.epoch, version = entry.version;
    try {
      const latest = await this.options.transport.get(documentId); if (!this.alive(epoch)) return; this.assertOwner(latest);
      // A user's explicit restore must not replace typing that started afterwards.
      if (entry.version !== version) { this.update(entry, { server: latest, conflict: latest, status: "conflict", error: "读取期间又有输入，已保留，请重新选择恢复或覆盖。" }); this.emit(); return; }
      if (choice === "restore") this.update(entry, { server: latest, body: latest.body ?? "", baseDocumentRevision: latest.baseDocumentRevision,
        dirty: false, editing: latest.body !== null, conflict: null, error: "", continuePublicationAttemptId: undefined, status: latest.body === null ? "idle" : "protected", version: entry.version + 1 });
      else {
        this.update(entry, { server: latest, conflict: null, error: "", status: "dirty", dirty: true });
        if (entry.documentId === null && latest.publishedDocumentId !== null && entry.baseDocumentRevision === null) this.update(entry, { baseDocumentRevision: latest.baseDocumentRevision });
        if (latest.body === entry.body && latest.baseDocumentRevision === entry.baseDocumentRevision) this.update(entry, { dirty: false, status: "protected" });
      }
      this.emit(); if (choice === "keep" && entry.dirty) await this.flush(documentId);
    } catch (reason) { if (this.alive(epoch)) this.failure(entry, reason); }
  }
  async remove(documentId: string | null): Promise<boolean> {
    if (this.disposed || this.phase === "blocked") return false;
    await this.running; const entry = this.entry(documentId), epoch = this.epoch, version = entry.version;
    if (!this.writable || this.phase !== "ready" || isHeld(entry) || entry.publishing || entry.status === "conflict") return false;
    this.cancelTimer();
    try {
      const removed = await this.options.transport.remove(documentId, entry.server.revision); if (!this.alive(epoch)) return false; this.assertOwner(removed);
      if (removed.body !== null) throw new Error("私稿没有确认删除。");
      if (entry.version !== version) this.update(entry, { server: removed, dirty: true, status: "dirty", conflict: null, error: "" });
      else this.update(entry, { server: removed, body: "", baseDocumentRevision: null, editing: false, dirty: false, status: "idle", conflict: null, error: "", continuePublicationAttemptId: undefined, version: entry.version + 1 });
      this.emit(); this.schedule(); return true;
    } catch (reason) { if (this.alive(epoch)) this.failure(entry, reason); return false; }
  }
  private outcome(entry: Entry, result: DraftPublicationOutcome) {
    this.assertOwner(result.draft);
    if (entry.documentId === null && entry.dirty && result.draft.body === null && result.receipt.status === "succeeded" && result.receipt.result
      && isHeld(entry) && entry.server.publication?.attemptId === result.receipt.attemptId) {
      this.update(entry, { continuePublicationAttemptId: result.receipt.attemptId, baseDocumentRevision: result.receipt.result.documentRevision });
    }
    this.update(entry, { server: result.draft, publishing: false });
    if (result.receipt.status === "succeeded") {
      if (result.draft.body === null && !entry.dirty) this.update(entry, { body: "", baseDocumentRevision: null, editing: false, status: "idle", error: "" });
      else if (result.draft.body !== entry.body) this.update(entry, { conflict: result.draft, status: "conflict", dirty: true, error: "团队正文已保存，另一窗口的新私稿仍保留。请选择恢复私稿，当前输入没有被覆盖。" });
      else this.update(entry, { baseDocumentRevision: result.draft.baseDocumentRevision, status: "protected", dirty: false, error: "" });
    } else this.update(entry, { error: result.receipt.errorMessage ?? "发布尚未确认，请查询原回执。", status: entry.dirty ? "dirty" : "protected" });
    this.emit();
  }
  async publish(documentId: string | null, retryOriginal = false): Promise<DraftPublicationOutcome | null> {
    if (this.disposed || this.phase === "blocked") return null;
    const entry = this.entry(documentId), epoch = this.epoch;
    if (entry.publishing || isHeld(entry) || !this.writable) return null;
    this.update(entry, { publishing: true }); this.emit();
    if (!await this.flush(documentId)) { this.update(entry, { publishing: false }); this.emit(); return null; }
    const previous = retryOriginal ? entry.server.publication : null;
    if (retryOriginal && previous?.status !== "failed") { this.update(entry, { publishing: false }); this.emit(); return null; }
    const key = previous?.attemptId ?? (this.options.attemptId?.() ?? crypto.randomUUID());
    try {
      const result = await this.options.transport.publish(documentId, { expectedOwnerId: this.options.ownerId, expectedRevision: previous?.sourceDraftRevision ?? entry.server.revision, attemptId: key, ...(retryOriginal ? { retryFailed: true } : {}) });
      if (!this.alive(epoch)) return null; this.outcome(entry, result); return result;
    } catch (reason) {
      if (!this.alive(epoch)) return null;
      if ([401, 403].includes(info(reason).status ?? 0)) { this.failure(entry, reason); return null; }
      const rejected = info(reason);
      if (rejected.status !== undefined && rejected.status < 500) {
        this.update(entry, { publishing: false, error: `没有发布，私人输入仍保留：${rejected.message}` });
        if (rejected.code === "VERSION_CONFLICT" || rejected.code === "DRAFT_PUBLICATION_PENDING") {
          try {
            const latest = await this.options.transport.get(documentId); if (!this.alive(epoch)) return null; this.assertOwner(latest);
            this.update(entry, { server: latest, conflict: latest, dirty: true, status: "conflict" });
          } catch (failure) { if (this.alive(epoch)) this.failure(entry, failure); }
        }
        this.emit(); return null;
      }
      // Network loss never generates another key. Read-only lookup is the only
      // recovery; a missing receipt is still not proof that a late write cannot commit.
      this.update(entry, { publishing: false, error: "发布结果尚未确认，请查询原回执；不会重复新建。",
        server: { ...entry.server, publication: { attemptId: key, documentId, targetDocumentId: documentId ?? entry.server.publishedDocumentId,
          sourceDraftRevision: entry.server.revision, contentRevision: entry.server.contentRevision, body: entry.body, baseDocumentRevision: entry.baseDocumentRevision,
          status: "unknown", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null,
          result: null, cleared: null, errorCode: "PUBLICATION_UNKNOWN", errorMessage: "发布结果尚未确认。" } } }); this.emit();
      return null;
    }
  }
  async checkPublication(documentId: string | null): Promise<DraftPublicationOutcome | null> {
    if (this.disposed || this.phase === "blocked") return null;
    const entry = this.entry(documentId), pending = entry.server.publication, epoch = this.epoch;
    if (!pending) return null;
    try {
      const saved = await this.options.transport.receipt(pending.attemptId); if (!this.alive(epoch)) return null;
      if (!saved) { this.update(entry, { error: "原回执暂未查到，请保留私稿继续核对；不会换编号重复新建。" }); this.emit(); return null; }
      const draft = await this.options.transport.get(documentId); if (!this.alive(epoch)) return null;
      const result = { receipt: saved, draft }; this.outcome(entry, result); return result;
    } catch (reason) { if (this.alive(epoch)) this.failure(entry, reason); return null; }
  }
  needsLeaveWarning() { return [...this.entries.values()].some(entry => entry.dirty || entry.publishing || entry.status === "error" || entry.status === "conflict"); }
}
