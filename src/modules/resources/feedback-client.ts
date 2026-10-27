/** Browser feedback state only. M08 remains the sole owner of persisted corrections. */
export interface ResourceCorrectionView {
  id: string;
  submittedBy: string;
  original: {
    target: { kind: "event" | "resource"; entityId: string; version: number };
    field: string;
    message: string;
    evidenceUrls: readonly string[];
    submittedAt: string;
  };
  status: "received" | "triaging" | "confirmed" | "needs_more_info" | "dismissed" | "resolved";
  revision: number;
  updatedAt: string;
  response: string | null;
  relatedVersion: { kind: "event" | "resource"; entityId: string; version: number } | null;
}
export interface ResourceCorrectionInput {
  target: { kind: "resource"; entityId: string; version: number };
  field: string;
  message: string;
  evidenceUrls: readonly string[];
}
export interface ResourceFeedbackTransport {
  list(signal: AbortSignal): Promise<unknown>;
  detail(id: string, signal: AbortSignal): Promise<unknown>;
  submit(input: ResourceCorrectionInput, signal: AbortSignal): Promise<unknown>;
}
export interface ResourceFeedbackState {
  ownerId: string | null;
  items: readonly ResourceCorrectionView[];
  selected: ResourceCorrectionView | null;
  busy: boolean;
  error: string;
  notice: string;
  accessLost: boolean;
  uncertainInput: ResourceCorrectionInput | null;
  reviewedUncertain: boolean;
}

const statuses = new Set(["received", "triaging", "confirmed", "needs_more_info", "dismissed", "resolved"]);
function record(value: unknown, ownerId: string): ResourceCorrectionView {
  const item = value as Partial<ResourceCorrectionView> | null;
  if (!item || typeof item.id !== "string" || !item.id || item.submittedBy !== ownerId
    || !item.original || !["event", "resource"].includes(item.original.target?.kind)
    || typeof item.original.target.entityId !== "string" || !item.original.target.entityId
    || !Number.isSafeInteger(item.original.target.version) || item.original.target.version < 1
    || typeof item.original.field !== "string" || typeof item.original.message !== "string"
    || !Array.isArray(item.original.evidenceUrls) || item.original.evidenceUrls.some(url => typeof url !== "string")
    || typeof item.original.submittedAt !== "string" || !statuses.has(item.status ?? "")
    || !Number.isSafeInteger(item.revision) || item.revision! < 1 || typeof item.updatedAt !== "string"
    || (item.response !== null && typeof item.response !== "string")) {
    throw Object.assign(new Error("反馈结果与当前账号或内容不符，已清除私人结果。请重新登录后再查看。"), { status: 403 });
  }
  return item as ResourceCorrectionView;
}
export function resourceCorrectionInput(resource: { id: string; version: number }, field: string, message: string, evidenceText: string): ResourceCorrectionInput {
  if (!resource.id || !Number.isSafeInteger(resource.version) || resource.version < 1) throw new Error("资源公开版本无效，请重新打开详情。");
  if (!field.trim() || field.length > 120) throw new Error("请选择或填写错误类型，最多 120 字。");
  if (!message.trim() || message.length > 4000) throw new Error("请说明哪里不准确，最多 4000 字。输入已保留。");
  const evidenceUrls = evidenceText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (evidenceUrls.length > 5) throw new Error("最多填写 5 个依据链接，每行一个。输入已保留。");
  return {
    target: { kind: "resource", entityId: resource.id, version: resource.version }, field: field.trim(), message: message.trim(),
    evidenceUrls: evidenceUrls.map(value => {
      try {
        if (value.length > 2000) throw new Error();
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
        return url.href;
      } catch { throw new Error("依据须为不含账号密码的 HTTP(S) 链接。输入已保留。"); }
    }),
  };
}

export const resourceCorrectionStatusLabels: Record<ResourceCorrectionView["status"], string> = {
  received: "已收到 · 待核查", triaging: "正在核查", confirmed: "已采纳 · 待修正",
  needs_more_info: "需要补充依据", dismissed: "未采纳", resolved: "已处理完毕",
};
function matchesInput(item: ResourceCorrectionView, input: ResourceCorrectionInput): boolean {
  return item.original.target.kind === "resource" && item.original.target.entityId === input.target.entityId
    && item.original.target.version === input.target.version && item.original.field === input.field
    && item.original.message === input.message && JSON.stringify(item.original.evidenceUrls) === JSON.stringify(input.evidenceUrls);
}

/** Reject late responses after account changes, even when the transport ignores cancellation. */
export function createResourceFeedbackClient(initialOwnerId: string | null, transport: ResourceFeedbackTransport) {
  const initial = (ownerId: string | null): ResourceFeedbackState => ({ ownerId, items: [], selected: null, busy: false, error: "", notice: "", accessLost: false, uncertainInput: null, reviewedUncertain: false });
  let state = initial(initialOwnerId), generation = 0, controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const update = (next: Partial<ResourceFeedbackState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
  const current = (ticket: number, owner: string, signal: AbortSignal) => ticket === generation && state.ownerId === owner && !signal.aborted;
  const fail = (reason: unknown, submitInput?: ResourceCorrectionInput) => {
    const error = reason instanceof Error ? reason.message : "读取或提交未完成，请稍后重试。";
    const status = Number((reason as { status?: unknown } | null)?.status);
    if ([401, 403, 404].includes(status)) update({ items: [], selected: null, busy: false, error, notice: "", accessLost: status !== 404, uncertainInput: null, reviewedUncertain: false });
    else if (submitInput && (!Number.isFinite(status) || status >= 500)) update({ busy: false, error: "提交结果尚未确认，输入已保留。请先刷新我的反馈，避免重复提交。", uncertainInput: submitInput, reviewedUncertain: false });
    else update({ busy: false, error, notice: "" });
  };
  const start = () => {
    if (!state.ownerId || state.accessLost || state.busy) return null;
    controller?.abort(); controller = new AbortController(); const ticket = ++generation, owner = state.ownerId;
    update({ busy: true, error: "", notice: "" });
    return { ticket, owner, signal: controller.signal };
  };
  const client = {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setIdentity(ownerId: string | null) {
      generation++; controller?.abort(); state = initial(ownerId); for (const listener of listeners) listener();
    },
    dispose() { generation++; controller?.abort(); listeners.clear(); },
    clearPrivate() { generation++; controller?.abort(); update({ ...initial(state.ownerId), accessLost: true, error: "登录或权限已变化，私人反馈已清除。请重新登录后查看。" }); },
    allowUnconfirmedRetry() {
      if (!state.ownerId || state.accessLost || state.busy || !state.uncertainInput || !state.reviewedUncertain) return;
      update({ uncertainInput: null, reviewedUncertain: false, error: "", notice: "你已核对列表并选择再次提交。此前请求仍可能已保存，请留意重复反馈。" });
    },
    async load() {
      const request = start(); if (!request) return;
      try {
        const values = await transport.list(request.signal);
        if (!current(request.ticket, request.owner, request.signal)) return;
        if (!Array.isArray(values)) throw new Error("未收到可读取的反馈列表，请重试。");
        const items = values.map(value => record(value, request.owner)).filter(value => value.original.target.kind === "resource");
        const recovered = state.uncertainInput ? items.find(value => matchesInput(value, state.uncertainInput!)) : null;
        update({ items, selected: recovered ?? (state.selected ? items.find(value => value.id === state.selected!.id) ?? null : null), busy: false,
          uncertainInput: recovered ? null : state.uncertainInput, reviewedUncertain: Boolean(state.uncertainInput && !recovered), notice: recovered ? "已找到刚才提交的真实反馈，请查看处理状态。" : "已读取本人最近 100 条反馈中的资源反馈。" });
      } catch (reason) { if (current(request.ticket, request.owner, request.signal)) fail(reason); }
    },
    async select(id: string) {
      if (!state.items.some(value => value.id === id)) return;
      const request = start(); if (!request) return;
      update({ selected: null });
      try {
        const value = await transport.detail(id, request.signal);
        if (!current(request.ticket, request.owner, request.signal)) return;
        const selected = record(value, request.owner);
        if (selected.id !== id || selected.original.target.kind !== "resource") throw Object.assign(new Error("反馈详情与所选记录不符，已清除私人结果。"), { status: 403 });
        update({ selected, items: state.items.map(item => item.id === id ? selected : item), busy: false });
      } catch (reason) { if (current(request.ticket, request.owner, request.signal)) fail(reason); }
    },
    async submit(input: ResourceCorrectionInput): Promise<ResourceCorrectionView | null> {
      if (state.uncertainInput) return null;
      const request = start(); if (!request) return null;
      try {
        const value = await transport.submit(input, request.signal);
        if (!current(request.ticket, request.owner, request.signal)) return null;
        const saved = record(value, request.owner);
        if (!matchesInput(saved, input)) throw Object.assign(new Error("提交回执与此资源或说明不符，已清除私人结果。"), { status: 403 });
        update({ selected: saved, items: [saved, ...state.items.filter(item => item.id !== saved.id)], busy: false,
          notice: "反馈已保存，等待运营核查。资源内容不会因提交反馈立即改变。" });
        return saved;
      } catch (reason) { if (current(request.ticket, request.owner, request.signal)) fail(reason, input); return null; }
    },
  };
  return client;
}
