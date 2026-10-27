"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type {
  Resource, ResourceBookmark, ResourceCostType, ResourcePrerequisite, ResourceQuery,
  ResourceStack, ResourceStage, ResourceType, ResourceUse,
} from "./domain.ts";
import type { ProjectResourceShareInput } from "./ports.ts";
import { resourceSiteIdentity } from "./site-identity.ts";
import styles from "./components.module.css";

const typeLabels: Record<ResourceType, string> = {
  inspiration: "设计灵感", ai_design: "AI 设计辅助", ui_visual: "UI 与视觉资源", practical_tool: "参赛实用工具",
};
const stageLabels: Record<ResourceStage, string> = {
  preparation: "备赛", design: "需求与设计", development: "开发与集成", delivery: "测试与交付", retrospective: "复盘",
};
const stackLabels: Record<ResourceStack, string> = {
  stack_agnostic: "与栈无关", html_css: "HTML / CSS", react: "React", vue: "Vue", unknown: "技术栈待确认",
};
const prerequisiteLabels: Record<ResourcePrerequisite, string> = {
  browse: "直接浏览", account: "需要注册", basic_code: "需要基础代码", environment: "需要环境配置",
};
const useLabels: Record<ResourceUse, string> = {
  layout: "找布局", workspace: "做工作台", form: "搭表单", flowchart: "画流程", icons: "选图标",
  prototype: "做原型", collaboration: "团队协作", development: "开发", deployment: "部署", presentation: "准备演示", review: "回顾经验",
};
const costLabels: Record<ResourceCostType, string> = {
  free_plan: "有免费方案", free_and_paid: "免费与付费", usage_based: "按量计费", self_hosted: "自部署成本", unknown: "费用未知",
};

function identityScope(resourceId: string, identityKey: string | null | undefined): string {
  return JSON.stringify([resourceId, typeof identityKey, identityKey ?? null]);
}

function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function safeNavigationUrl(value: string | undefined): string | null {
  if (value && !/[\\\u0000-\u0020\u007f]/.test(value) && value.startsWith("/") && !value.startsWith("//")) return value;
  return safeExternalUrl(value);
}

function canVisit(resource: Resource): boolean {
  return resource.publicationStatus === "published" && !resource.externalLinkBlocked && !!safeExternalUrl(resource.officialUrl);
}

function canShare(resource: Resource): boolean {
  return canVisit(resource) && resource.linkStatus === "available" && !!resource.reviewId;
}

function canBookmark(resource: Resource): boolean {
  return resource.publicationStatus === "published" && !resource.externalLinkBlocked;
}

function blockedReason(resource: Resource): string {
  if (resource.publicationStatus === "withdrawn") return `资源已下架${resource.withdrawnReason ? `：${resource.withdrawnReason}` : "。"}`;
  if (resource.externalLinkBlocked) return "此资源的外部链接已暂停提供。";
  if (resource.publicationStatus !== "published") return "此资源尚未发布。";
  return "外部链接暂不可用。";
}

function CheckedTime({ value }: { value: string | null }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <span>尚未核验</span>;
  const label = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
  return <time dateTime={value}>{label}（UTC+8）</time>;
}

/** A request result, rather than animation or elapsed time, determines success. */
function useOperation(scope: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const operation = useRef({ busy: false, generation: 0, mounted: false });

  useEffect(() => {
    operation.current.mounted = true;
    operation.current.generation += 1;
    operation.current.busy = false;
    setPending(false);
    setError("");
    setMessage("");
    return () => {
      operation.current.mounted = false;
      operation.current.generation += 1;
    };
  }, [scope]);

  async function run<T>(action: () => Promise<T>, onSuccess: (value: T) => void) {
    if (operation.current.busy) return;
    operation.current.busy = true;
    const generation = operation.current.generation;
    setPending(true);
    setError("");
    setMessage("");
    const active = () => operation.current.mounted && operation.current.generation === generation;
    try {
      const result = await action();
      if (active()) onSuccess(result);
    } catch (failure) {
      if (active()) setError(failure instanceof Error && failure.message ? failure.message : "操作未完成，请稍后重试。输入已保留。");
    } finally {
      if (active()) {
        operation.current.busy = false;
        setPending(false);
      }
    }
  }

  return { pending, error, message, setError, setMessage, run };
}

function ResourceStatus({ resource, verificationState }: { resource: Resource; verificationState?: "unknown" | "current" | "stale" }) {
  return <div className={styles.statuses}>
    {resource.publicationStatus === "published" && resource.reviewId && <span>人工审核 · 内容版本 {resource.version}</span>}
    {resource.publicationStatus === "withdrawn" && <span className={styles.dangerTag}>已下架</span>}
    {resource.publicationStatus === "draft" && <span className={styles.warningTag}>未发布草稿</span>}
    {resource.publicationStatus === "in_review" && <span className={styles.warningTag}>审核中</span>}
    {resource.externalLinkBlocked && <span className={styles.dangerTag}>外链已停用</span>}
    {resource.linkStatus === "unreachable" && <span className={styles.warningTag}>上次访问失败</span>}
    {resource.linkStatus === "unknown" && <span className={styles.warningTag}>链接待核验</span>}
    {verificationState === "stale" && <span className={styles.warningTag}>核验信息需复核</span>}
  </div>;
}

export interface ResourceCardProps {
  resource: Resource;
  /** Supply the trusted identity when using private bookmark actions. */
  identityKey?: string | null;
  detailHref?: string;
  bookmark?: ResourceBookmark | null;
  bookmarkState?: "loading" | "ready" | "error";
  onBookmark?: (input: { resourceId: string; purposeNote: string }) => Promise<ResourceBookmark>;
  loginHref?: string;
  verificationState?: "unknown" | "current" | "stale";
}

export function ResourceCard(props: ResourceCardProps) {
  return <ResourceCardContent key={identityScope(props.resource.id, props.identityKey)} {...props}
    bookmark={props.identityKey === null ? null : props.bookmark}
    onBookmark={props.identityKey === null ? undefined : props.onBookmark} />;
}

function ResourceCardContent({ resource, identityKey, detailHref, bookmark, bookmarkState = "ready", onBookmark, loginHref, verificationState }: ResourceCardProps) {
  const titleId = useId();
  const [saved, setSaved] = useState(bookmark ?? null);
  const operation = useOperation(identityScope(resource.id, identityKey));
  const href = safeNavigationUrl(detailHref) ?? `/resources/${encodeURIComponent(resource.id)}`;
  const login = safeNavigationUrl(loginHref);
  useEffect(() => { setSaved(bookmark ?? null); }, [resource.id, bookmark?.id, bookmark?.revision]);

  function save() {
    if (!onBookmark || saved || bookmarkState !== "ready" || !canBookmark(resource)) return;
    void operation.run(async () => {
      const result = await onBookmark({ resourceId: resource.id, purposeNote: "" });
      if (!result.id || result.resourceId !== resource.id) throw new Error("暂未收到有效收藏结果，请核对后重试。");
      return result;
    }, result => {
      setSaved(result);
      operation.setMessage("已加入个人收藏，仅你可见。");
    });
  }

  return <article className={styles.card} aria-labelledby={titleId}>
    <div className={styles.cardCategory}><span aria-hidden="true">▤</span>{typeLabels[resource.type]}</div>
    <ResourceStatus resource={resource} verificationState={verificationState} />
    <h3 id={titleId} className={styles.cardTitle}><a href={href}>{resource.name}</a></h3>
    <p className={styles.summary}>{resource.summary}</p>
    <ul className={styles.tags} aria-label="技术栈、门槛与费用">
      {resource.stackTags.map(tag => <li key={tag}>{stackLabels[tag]}</li>)}
      {resource.prerequisites.map(tag => <li key={tag}>{prerequisiteLabels[tag]}</li>)}
      <li className={resource.costType === "unknown" ? styles.warningTag : undefined}>{costLabels[resource.costType]}</li>
    </ul>
    {resource.publicationStatus === "withdrawn" && <p className={styles.warning}>{blockedReason(resource)}</p>}
    <p className={styles.metadata}>链接核验：<CheckedTime value={resource.verifiedAt} /></p>
    <div className={styles.cardActions}>
      <a className={styles.secondaryButton} href={href}>看详情<span aria-hidden="true"> →</span></a>
      {bookmarkState === "loading" ? <span className={styles.metadata}>正在读取收藏…</span> : bookmarkState === "error" ? <span className={styles.metadata}>收藏状态暂未读到</span> : saved ? <span className={styles.savedLabel}>✓ 已收藏</span> : onBookmark && canBookmark(resource) ?
        <button className={styles.textButton} type="button" onClick={save} disabled={operation.pending}>{operation.pending ? "正在收藏…" : "收藏"}</button> :
        login && canBookmark(resource) ? <a className={styles.textButton} href={login}>登录后收藏</a> : null}
    </div>
    {operation.error && <p className={styles.error} role="alert">{operation.error}</p>}
    <p className={styles.operationMessage} role="status">{operation.message}</p>
  </article>;
}

export interface ResourceFilterOptions {
  types?: readonly ResourceType[];
  stages?: readonly ResourceStage[];
  stacks?: readonly ResourceStack[];
  prerequisites?: readonly ResourcePrerequisite[];
  uses?: readonly ResourceUse[];
  costTypes?: readonly ResourceCostType[];
}
export interface ResourceFiltersProps {
  value: ResourceQuery;
  onApply: (query: ResourceQuery) => Promise<void> | void;
  availableOptions?: ResourceFilterOptions;
  resultCount?: number;
  loading?: boolean;
}

export function ResourceFilters({ value, onApply, availableOptions = {}, resultCount, loading = false }: ResourceFiltersProps) {
  const id = useId();
  const [draft, setDraft] = useState<ResourceQuery>(value);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => { setFiltersOpen(window.matchMedia("(min-width: 640px)").matches); }, []);
  const operation = useOperation("resource-filters");
  const valueKey = JSON.stringify(value);
  useEffect(() => { setDraft(value); }, [valueKey]);
  const busy = operation.pending || loading;
  const fields = [
    { key: "type", label: "资源类型", labels: typeLabels, options: availableOptions.types },
    { key: "stage", label: "参赛阶段", labels: stageLabels, options: availableOptions.stages },
    { key: "stack", label: "技术栈", labels: stackLabels, options: availableOptions.stacks },
    { key: "prerequisite", label: "使用门槛", labels: prerequisiteLabels, options: availableOptions.prerequisites },
    { key: "costType", label: "费用类型", labels: costLabels, options: availableOptions.costTypes },
  ] as const;

  function change(key: keyof ResourceQuery, next: string) {
    setDraft(previous => {
      const updated = { ...previous, [key]: next, cursor: undefined };
      if (!next) delete updated[key];
      return updated;
    });
    operation.setError("");
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const { cursor: _cursor, ...query } = draft;
    void operation.run(async () => { await onApply(query); }, () => {});
  }

  function clear() {
    if (busy) return;
    void operation.run(async () => { await onApply({}); }, () => { setDraft({}); });
  }

  return <form className={styles.filters} onSubmit={apply} aria-busy={busy}>
    <label className={styles.searchLabel} htmlFor={`${id}-search`}>查找工具或资料</label>
    <div className={styles.searchRow}>
      <input id={`${id}-search`} type="search" value={draft.search ?? ""} maxLength={200} placeholder="名称或关键词，例如：表单、演示" onChange={event => change("search", event.target.value)} disabled={busy} />
      <button className={styles.primaryButton} type="submit" disabled={busy}>{busy ? "正在查找…" : "搜索"}</button>
    </div>
    <div className={styles.taskFilter}>
      <label htmlFor={`${id}-use`}>你想完成什么？</label>
      <select id={`${id}-use`} value={draft.use ?? ""} onChange={event => change("use", event.target.value)} disabled={busy}>
        <option value="">所有用途</option>
        {(availableOptions.uses ?? Object.keys(useLabels) as ResourceUse[]).map(option => <option key={option} value={option}>{useLabels[option]}</option>)}
      </select>
      <button className={styles.secondaryButton} type="submit" disabled={busy}>按用途查找</button>
    </div>
    <details className={styles.filterDisclosure} open={filtersOpen} onToggle={event => setFiltersOpen(event.currentTarget.open)}>
      <summary>更多条件：阶段、技术栈与费用</summary>
      <div className={styles.filterGrid}>
        {fields.map(field => {
          const options = field.options ?? Object.keys(field.labels);
          if (!options.length) return null;
          const labels = field.labels as Record<string, string>;
          return <div className={styles.field} key={field.key}>
            <label htmlFor={`${id}-${field.key}`}>{field.label}</label>
            <select id={`${id}-${field.key}`} value={draft[field.key] ?? ""} onChange={event => change(field.key, event.target.value)} disabled={busy}>
              <option value="">全部</option>
              {options.map(option => <option key={option} value={option}>{labels[option]}</option>)}
            </select>
          </div>;
        })}
        <div className={styles.field}>
          <label htmlFor={`${id}-sort`}>排序</label>
          <select id={`${id}-sort`} value={draft.sort ?? "editorial"} onChange={event => change("sort", event.target.value)} disabled={busy}>
            <option value="editorial">编辑顺序</option><option value="name">名称</option><option value="verified">最近核验</option>
          </select>
        </div>
      </div>
      <div className={styles.filterActions}>
        <button className={styles.secondaryButton} type="submit" disabled={busy}>应用筛选</button>
        <button className={styles.textButton} type="button" onClick={clear} disabled={busy}>清除筛选</button>
      </div>
      <p className={styles.help}>“有免费方案”表示有已核验的免费选项，具体功能和额度请看详情。</p>
    </details>
    {operation.error && <p className={styles.error} role="alert">{operation.error}</p>}
    <p className={styles.metadata} role="status">{busy ? "正在更新结果…" : resultCount === undefined ? "" : `当前页显示 ${resultCount} 条资源`}</p>
  </form>;
}

function Source({ resource, url, label, checkedAt }: { resource: Resource; url: string | null; label: string; checkedAt: string | null }) {
  const href = safeExternalUrl(url);
  return <div className={styles.source}>
    {href && canVisit(resource) ? <a href={href} target="_blank" rel="noopener noreferrer">{label} <span aria-hidden="true">↗</span><span className={styles.srOnly}>（在新窗口打开）</span></a> :
      <span>{href ? `${label}（当前已暂停外链）` : `${label}尚未记录`}</span>}
    <span className={styles.metadata}>核验时间：<CheckedTime value={checkedAt} /></span>
  </div>;
}

export interface ResourceDetailProps {
  resource: Resource;
  verificationState?: "unknown" | "current" | "stale";
  bookmarkEditor?: ReactNode;
  projectShare?: ReactNode;
  onReport?: (resourceId: string) => void;
}

export function ResourceDetail({ resource, verificationState, bookmarkEditor, projectShare, onReport }: ResourceDetailProps) {
  const official = safeExternalUrl(resource.officialUrl);
  const site = resourceSiteIdentity(resource.officialUrl);
  return <article className={styles.detail}>
    <header className={styles.detailHeader}>
      <p className={styles.eyebrow}>{typeLabels[resource.type]}</p>
      <h1>{resource.name}</h1>
      <ResourceStatus resource={resource} verificationState={verificationState} />
      <p className={styles.detailSummary}>{resource.summary}</p>
      <p className={styles.help}>内容来源：运营整理的外部资料{resource.reviewId ? resource.publicationStatus === "published" ? "，已通过人工审核" : "，保留历史人工审核记录" : "，审核状态见上方"}。费用、许可与链接各自保留核验依据；这条说明不表示已完成 DSH 官网分析。</p>
      {site && <p className={styles.help}>所属站点：{site.name}。{canVisit(resource) && <><a href={site.inspirationHref}>查看同站官网说明 →</a>（可能仍在等待 DSH 分析）。</>}本文的产品、版本与许可范围保持独立。</p>}
      {canVisit(resource) && official ? <a className={styles.primaryButton} href={official} target="_blank" rel="noopener noreferrer">访问官方资源 <span aria-hidden="true">↗</span><span className={styles.srOnly}>（在新窗口打开）</span></a> :
        <p className={styles.warning}>{blockedReason(resource)}</p>}
      {resource.linkStatus === "unreachable" && <p className={styles.warning}>上次核验时无法访问。你仍可阅读资料，或报告链接问题。</p>}
    </header>
    <div className={styles.detailGrid}>
      <div className={styles.detailMain}>
        <section className={styles.detailSection}><h2>它适合帮你做什么</h2><p>{resource.suitableFor}</p><h3>使用前先确认</h3><p>{resource.notSuitableFor}</p>
          {resource.type === "inspiration" && <p className={styles.help}>设计参考不授予图片、商标或代码的使用权。</p>}
          {resource.type === "ai_design" && <p className={styles.help}>生成内容是草稿，需要检查视觉、代码和赛事使用规则。</p>}
          {resource.type === "ui_visual" && <p className={styles.help}>组件接入后仍需验证功能、依赖与可访问性，优先统一一套体系。</p>}
        </section>
        <section className={styles.detailSection}><h2>从这里开始</h2><ol className={styles.steps}>{resource.quickStart.map((step, index) => <li key={index}>{step}</li>)}</ol></section>
        <section className={styles.detailSection}><h2>费用与使用许可</h2><h3>{costLabels[resource.costType]}</h3><p>{resource.costNote}</p>
          {resource.costType === "unknown" && <p className={styles.warning}>费用尚未核实，请在使用前确认。</p>}
          <p className={styles.help}>队伍可以沿用已有工具，或手动完成任务；这条资源不是参赛必需。</p>
          <Source resource={resource} url={resource.costSourceUrl} label="费用官方依据" checkedAt={resource.costVerifiedAt} />
          <h3>{resource.licenseStatus === "unknown" ? "许可待确认" : "许可依据已核验"}</h3><p>{resource.licenseNote}</p>
          <Source resource={resource} url={resource.licenseSourceUrl} label="许可原始依据" checkedAt={resource.licenseVerifiedAt} />
          <p className={styles.help}>赛事是否允许 AI 或预制组件，仍以该赛事已核实的规则为准。</p>
        </section>
      </div>
      <aside className={styles.detailAside} aria-label="资源信息与保存">
        <section className={styles.infoPanel}><h2>适用条件</h2><dl className={styles.infoList}>
          <dt>参赛阶段</dt><dd>{resource.stageTags.map(tag => stageLabels[tag]).join("、")}</dd>
          <dt>用途</dt><dd>{resource.useTags.map(tag => useLabels[tag]).join("、")}</dd>
          <dt>技术栈</dt><dd>{resource.stackTags.map(tag => stackLabels[tag]).join("、")}</dd>
          <dt>门槛</dt><dd>{resource.prerequisites.map(tag => prerequisiteLabels[tag]).join("、")}</dd>
          <dt>链接核验</dt><dd><CheckedTime value={resource.verifiedAt} /></dd>
          <dt>资源内容版本</dt><dd>{resource.version}</dd>
        </dl></section>
        {bookmarkEditor}{projectShare}
        {onReport && <button type="button" className={styles.textButton} onClick={() => onReport(resource.id)}>报告失效或信息错误</button>}
      </aside>
    </div>
  </article>;
}

export interface ResourceBookmarkSaveInput {
  resourceId: string;
  purposeNote: string;
  bookmarkId?: string;
  expectedRevision?: number;
}
export interface ResourceBookmarkEditorProps {
  resource: Resource;
  /** Trusted user ID or session identity key. Private props must belong to it. */
  identityKey: string | null;
  isAuthenticated: boolean;
  bookmark?: ResourceBookmark | null;
  onSave?: (input: ResourceBookmarkSaveInput) => Promise<ResourceBookmark>;
  onRemove?: (input: { bookmarkId: string; resourceId: string; expectedRevision: number }) => Promise<void>;
  loginHref?: string;
}

export function ResourceBookmarkEditor(props: ResourceBookmarkEditorProps) {
  const authenticated = props.isAuthenticated && typeof props.identityKey === "string" && props.identityKey.length > 0;
  return <ResourceBookmarkEditorContent key={identityScope(props.resource.id, authenticated ? props.identityKey : null)} {...props}
    isAuthenticated={authenticated} bookmark={authenticated ? props.bookmark : null} />;
}

function ResourceBookmarkEditorContent({ resource, identityKey, isAuthenticated, bookmark, onSave, onRemove, loginHref }: ResourceBookmarkEditorProps) {
  const id = useId();
  const [saved, setSaved] = useState(bookmark ?? null);
  const [note, setNote] = useState(bookmark?.purposeNote ?? "");
  const dirty = useRef(false);
  const operation = useOperation(identityScope(resource.id, identityKey));
  const login = safeNavigationUrl(loginHref);
  const incomingChange = !!bookmark && !!saved && bookmark.id === saved.id && bookmark.revision > saved.revision && dirty.current;

  useEffect(() => {
    if (!dirty.current) {
      setSaved(bookmark ?? null);
      setNote(bookmark?.purposeNote ?? "");
    }
  }, [resource.id, bookmark?.id, bookmark?.revision]);

  function save(event: FormEvent) {
    event.preventDefault();
    if (!isAuthenticated || !onSave || incomingChange || (!saved && !canBookmark(resource))) return;
    const input: ResourceBookmarkSaveInput = {
      resourceId: resource.id, purposeNote: note,
      ...(saved ? { bookmarkId: saved.id, expectedRevision: saved.revision } : {}),
    };
    void operation.run(async () => {
      const result = await onSave(input);
      if (!result.id || result.resourceId !== resource.id) throw new Error("暂未收到有效收藏结果，请核对后重试。备注已保留。");
      return result;
    }, result => {
      setSaved(result);
      setNote(result.purposeNote);
      dirty.current = false;
      operation.setMessage("个人收藏已保存，仅你可见。");
    });
  }

  function remove() {
    if (!isAuthenticated || !saved || !onRemove) return;
    const input = { bookmarkId: saved.id, resourceId: resource.id, expectedRevision: saved.revision };
    void operation.run(() => onRemove(input), () => {
      setSaved(null);
      dirty.current = true;
      operation.setMessage("已移除个人收藏，项目共享资料仍保留。");
    });
  }

  return <section className={styles.infoPanel} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>个人收藏{isAuthenticated && saved ? " · 已收藏" : ""}</h2>
    <p className={styles.help}>默认只有你能看到。共享到项目需要单独选择项目。</p>
    {!isAuthenticated ? <div><p>登录后可以保存用途和参考备注。</p>{login && <a className={styles.secondaryButton} href={login}>登录后收藏</a>}</div> :
      <form onSubmit={save} aria-busy={operation.pending}>
        <div className={styles.field}><label htmlFor={`${id}-note`}>你准备怎么使用它？</label>
          <textarea id={`${id}-note`} value={note} maxLength={1000} rows={4} aria-describedby={`${id}-note-help${operation.error ? ` ${id}-error` : ""}`} disabled={operation.pending} onChange={event => {
            setNote(event.target.value); dirty.current = true; operation.setError(""); operation.setMessage("");
          }} />
          <p id={`${id}-note-help`} className={styles.help}>可以记下要参考的部分，最多 1000 字。</p>
        </div>
        {incomingChange && <div className={styles.warning}><p>收藏备注已有更新，你的草稿已保留。请先核对最新备注。</p><p className={styles.preservedText}>{bookmark.purposeNote || "最新备注为空。"}</p><button className={styles.secondaryButton} type="button" disabled={operation.pending} onClick={() => {
          setSaved(bookmark); operation.setError(""); operation.setMessage("已按最新版本继续编辑，草稿仍保留。");
        }}>按最新版本继续编辑</button></div>}
        {!saved && !canBookmark(resource) && <p className={styles.warning}>当前资源不能新增收藏，已有引用仍保留。</p>}
        {!onSave && <p className={styles.warning}>暂时无法保存收藏，请稍后再试。</p>}
        <div className={styles.editorActions}>
          <button className={styles.primaryButton} type="submit" disabled={operation.pending || !onSave || incomingChange || (!saved && !canBookmark(resource))}>{operation.pending ? "正在处理…" : saved ? "保存备注" : "加入个人收藏"}</button>
          {saved && onRemove && <button className={styles.textButton} type="button" onClick={remove} disabled={operation.pending}>移除个人收藏</button>}
        </div>
      </form>}
    {operation.error && <p id={`${id}-error`} className={styles.error} role="alert">{operation.error} 备注已保留。</p>}
    <p className={styles.operationMessage} role="status">{operation.message}</p>
  </section>;
}

export interface ResourceShareProject { id: string; name: string }
export interface ResourceProjectShareProps {
  resource: Resource;
  /** Trusted user ID or session identity key. Projects and initial note belong to it. */
  identityKey: string | null;
  isAuthenticated: boolean;
  /** The caller supplies accessible projects; the server still rechecks membership. */
  projects: readonly ResourceShareProject[];
  onShare?: (input: ProjectResourceShareInput) => Promise<{ id: string; projectId: string }>;
  initialPurposeNote?: string;
  loginHref?: string;
}

export function ResourceProjectShare(props: ResourceProjectShareProps) {
  const authenticated = props.isAuthenticated && typeof props.identityKey === "string" && props.identityKey.length > 0;
  return <ResourceProjectShareContent key={identityScope(props.resource.id, authenticated ? props.identityKey : null)} {...props}
    isAuthenticated={authenticated} projects={authenticated ? props.projects : []}
    initialPurposeNote={authenticated ? props.initialPurposeNote : ""} />;
}

function ResourceProjectShareContent({ resource, identityKey, isAuthenticated, projects, onShare, initialPurposeNote = "", loginHref }: ResourceProjectShareProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [note, setNote] = useState(initialPurposeNote);
  const [selectionError, setSelectionError] = useState("");
  const dirty = useRef(false);
  const operation = useOperation(identityScope(resource.id, identityKey));
  const project = projects.find(item => item.id === projectId);
  const login = safeNavigationUrl(loginHref);

  function closeDialog() {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!dirty.current) setNote(initialPurposeNote);
  }, [initialPurposeNote]);

  useEffect(() => {
    const mountedDialog = dialog.current;
    return () => { if (mountedDialog?.open) mountedDialog.close(); };
  }, []);

  function openDialog() {
    if (operation.pending || !canShare(resource) || !onShare || !isAuthenticated) return;
    setSelectionError("");
    operation.setError("");
    operation.setMessage("");
    dialog.current?.showModal();
    setOpen(true);
  }

  function share(event: FormEvent) {
    event.preventDefault();
    if (!isAuthenticated || !onShare || !canShare(resource)) return;
    if (!project) {
      setSelectionError("请明确选择一个你有权限的项目。");
      return;
    }
    const input: ProjectResourceShareInput = {
      projectId: project.id, resourceId: resource.id, resourceVersion: resource.version,
      title: resource.name, url: resource.officialUrl, purposeNote: note,
    };
    const projectName = project.name;
    void operation.run(async () => {
      const result = await onShare(input);
      if (!result.id || result.projectId !== input.projectId) throw new Error("暂未收到有效共享结果，请核对项目资料。备注已保留。");
      return result;
    }, () => {
      operation.setMessage(`已分享到「${projectName}」团队空间。`);
      closeDialog();
    });
  }

  return <section className={styles.infoPanel} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>分享到团队空间</h2>
    <p className={styles.help}>只共享本条资源和本次备注，项目成员可以查看。</p>
    {!isAuthenticated ? <div><p>登录后选择你参与的参赛项目（团队空间）。</p>{login && <a className={styles.secondaryButton} href={login}>登录后分享</a>}</div> :
      !canShare(resource) ? <p className={styles.warning}>当前资源不可用于新增项目共享，已有资料引用仍保留。</p> :
      !projects.length ? <p className={styles.help}>你还没有可分享资料的团队空间。<a href="/app">先创建或加入参赛项目 →</a></p> :
      !onShare ? <p className={styles.warning}>暂时无法共享，请稍后再试。</p> :
      <button ref={trigger} className={styles.secondaryButton} type="button" onClick={openDialog} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-dialog`} aria-disabled={operation.pending}>{operation.pending ? "正在分享…" : "选择团队空间"}</button>}
    <p className={operation.pending ? styles.metadata : styles.operationMessage} role="status">{operation.pending && !open ? "正在加入项目，结果确认后会显示在这里。" : operation.message}</p>
    {operation.error && !open && <p className={styles.error} role="alert">{operation.error}</p>}
    <dialog ref={dialog} id={`${id}-dialog`} className={styles.dialog} aria-labelledby={`${id}-dialog-title`} aria-describedby={`${id}-dialog-description`} onCancel={event => { event.preventDefault(); closeDialog(); }} onClose={() => { setOpen(false); trigger.current?.focus(); }}>
      <div className={styles.dialogHeader}><h2 id={`${id}-dialog-title`}>选择要分享的团队空间</h2><button type="button" className={styles.textButton} onClick={closeDialog} aria-label="关闭分享窗口">关闭</button></div>
      <p id={`${id}-dialog-description`} className={styles.help}>确认后，以下内容会加入所选项目资料。个人收藏保持私有。</p>
      <form onSubmit={share} noValidate aria-busy={operation.pending}>
        <div className={styles.field}><label htmlFor={`${id}-project`}>分享到哪个参赛项目（团队空间）</label>
          <select autoFocus id={`${id}-project`} value={projectId} onChange={event => { setProjectId(event.target.value); setSelectionError(""); operation.setError(""); }} disabled={operation.pending} aria-invalid={!!selectionError} aria-describedby={selectionError ? `${id}-selection-error` : undefined}>
            <option value="">请选择项目</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {selectionError && <p id={`${id}-selection-error`} className={styles.error} role="alert">{selectionError}</p>}
        </div>
        <div className={styles.field}><label htmlFor={`${id}-share-note`}>共享备注（最多 1000 字）</label><textarea id={`${id}-share-note`} value={note} maxLength={1000} rows={4} disabled={operation.pending} onChange={event => { setNote(event.target.value); dirty.current = true; operation.setError(""); }} /></div>
        <section className={styles.sharePreview} aria-label="将共享的内容"><h3>将共享的内容</h3><dl className={styles.infoList}>
          <dt>项目</dt><dd>{project?.name ?? "尚未选择"}</dd><dt>标题</dt><dd>{resource.name}</dd><dt>链接</dt><dd className={styles.urlText}>{resource.officialUrl}</dd><dt>备注</dt><dd className={styles.preservedText}>{note || "无备注"}</dd>
        </dl></section>
        {operation.error && <p className={styles.error} role="alert">{operation.error} 输入已保留，请核对后再试。</p>}
        <div className={styles.editorActions}><button className={styles.primaryButton} type="submit" disabled={operation.pending || !canShare(resource)}>{operation.pending ? "正在分享…" : "确认分享到团队空间"}</button><button className={styles.textButton} type="button" onClick={closeDialog}>{operation.pending ? "关闭窗口（操作继续）" : "返回"}</button></div>
      </form>
    </dialog>
  </section>;
}

export interface ResourceListProps {
  resources: readonly Resource[];
  loading?: boolean;
  error?: string;
  renderCard?: (resource: Resource) => ReactNode;
  onRetry?: () => void;
  onClearFilters?: () => void;
  /** The composing public page can distinguish an empty catalog from no matches. */
  emptyState?: ReactNode;
}

export function ResourceList({ resources, loading = false, error, renderCard, onRetry, onClearFilters, emptyState }: ResourceListProps) {
  return <section className={styles.resourceList} aria-label="资源列表" aria-busy={loading}>
    <p className={styles.metadata} role="status">{loading ? resources.length ? "正在更新列表，现有资料仍可阅读。" : "正在读取资源…" : ""}</p>
    {error && <div className={styles.listNotice}><p className={styles.error} role="alert">{error}</p>{onRetry && <button className={styles.secondaryButton} type="button" onClick={onRetry} disabled={loading}>重新读取</button>}</div>}
    {!resources.length && !loading && !error && <div className={styles.emptyState}>{emptyState ?? <><h2>没有符合条件的资源</h2><p>试试更短的关键词，或清除筛选条件。</p>{onClearFilters && <button className={styles.secondaryButton} type="button" onClick={onClearFilters}>清除筛选</button>}</>}</div>}
    {!resources.length && loading && <div className={styles.cardGrid} aria-hidden="true">{[0, 1, 2].map(item => <div className={styles.skeleton} key={item} />)}</div>}
    {!!resources.length && <div className={styles.cardGrid}>{resources.map(resource => <div key={resource.id}>{renderCard ? renderCard(resource) : <ResourceCard resource={resource} />}</div>)}</div>}
  </section>;
}
