"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileChange, FileIssue, GitOperation, RepositoryBinding, RepositoryTarget } from "../modules/github/types.ts";
import { ApiError, api, dateText, operationKey, safeLink, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading, type SystemStatus } from "./site-shell.tsx";
import type { ProjectDetail } from "./projects-client.tsx";
import { useAction } from "./workflow.tsx";
import { GitHubConnection } from "./github-connection.tsx";
import { PresentationProjectEntry } from "./presentation-workflow.tsx";
import styles from "./site.module.css";

interface EditChange extends FileChange { uiId: string }
const MANIFEST_LIMITS = Object.freeze({ files: 100, fileBytes: 1_048_576, totalBytes: 5_242_880, pathBytes: 1_024, segmentBytes: 255 });
const unsupportedUploadExtension = /\.(?:zip|7z|rar|tar|gz|bz2|xz|pdf|png|jpe?g|gif|webp|ico|bmp|tiff?|mp[34]|wav|ogg|avi|mov|woff2?|ttf|otf|exe|dll|bin|wasm|sqlite3?|db|docx?|xlsx?|pptx?|p12|pfx)$/iu;
const uploadAccept = ".txt,.md,.mdx,.ts,.tsx,.js,.jsx,.mjs,.cjs,.json,.html,.css,.scss,.svg,.yml,.yaml,.toml,.ini,.csv,.xml,.sql,.py,.rs,.go,.java,.c,.h,.cpp,.sh,.ps1,.gitignore,.editorconfig";
const pathControls = /[\u0000-\u001f\u007f-\u009f]/u;
const textControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
function hasIsolatedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return true; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}
function credentialPath(path: string): boolean {
  const segments = path.toLowerCase().split("/"), name = segments.at(-1) ?? "";
  return segments.some(segment => segment === ".ssh" || segment === ".aws") || /^\.env(?:\.|$)/u.test(name)
    || /^(?:\.npmrc|\.pypirc|\.netrc|_netrc|id_rsa|id_dsa|id_ecdsa|id_ed25519|kubeconfig|application_default_credentials\.json)$/u.test(name)
    || /^(?:credentials?|secrets?)(?:\.(?:json|ini|ya?ml|toml))?$/u.test(name)
    || /^service[-_]?account(?:[-_.].*)?\.json$/u.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/u.test(name);
}
/** Return a generic reason, never the matched credential value. */
function secretReason(content: string): string | null {
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u.test(content)) return "疑似私钥内容";
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/u.test(content)) return "疑似 GitHub 访问令牌";
  if (/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,255}\b/u.test(content)) return "疑似服务访问密钥";
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(content)) return "疑似云访问凭据";
  if (/\b(?:AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{16,255})\b/u.test(content)) return "疑似服务访问令牌";
  if (/[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]{1,1024}:[^\s/@]{1,4096}@/iu.test(content)) return "疑似带密码的连接地址";
  if (/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/u.test(content)) return "疑似身份访问令牌";
  const assignments = /["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|password|passwd|private[_-]?key)["']?\s*[:=]\s*(?:["'`]([^"'`\r\n]{12,})["'`]|([^\s,;\r\n]{12,}))/giu;
  for (const match of content.matchAll(assignments)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (/^(?:process\.env\.|import\.meta\.env\.|Deno\.env\.|os\.environ|os\.getenv|env\(|getenv\(|\$\{|\{\{|<)/iu.test(value)) continue;
    if (/^(?:your[_-]|replace[_-]|example[_-]|placeholder|changeme|change-me|not[_-]a[_-]real|dummy[_-]|test[_-]|undefined|null|true|false)/iu.test(value)) continue;
    if (/^\*+$|^x+$/iu.test(value)) continue;
    if (match[1] === undefined && /^[A-Za-z_$][\w$]*(?:\.[\w$]+|\([^\r\n]*\))+$/u.test(value)) continue;
    return "疑似明文密码或密钥配置";
  }
  return null;
}
/** Browser checks stop unsafe local input early; the server manifest and preview remain authoritative. */
function validateTextChanges(changes: FileChange[]): FileIssue[] {
  const issues: FileIssue[] = [], encoder = new TextEncoder(), paths = new Map<string, string>(), prefixes = new Map<string, string>();
  const key = (value: string) => value.normalize("NFC").toLowerCase().normalize("NFC");
  const block = (path: string, code: string, message: string) => issues.push({ path, code, message, severity: "blocked" });
  let total = 0;
  if (changes.length > MANIFEST_LIMITS.files) block("", "FILE_COUNT_EXCEEDED", "一次最多保存 100 份文件，请拆分保存。");
  for (const change of changes) {
    const path = change.path.normalize("NFC"), segments = path.split("/"), lower = segments.map(segment => segment.toLowerCase());
    const display = pathControls.test(path) || hasIsolatedSurrogate(path) ? "" : path.slice(0, MANIFEST_LIMITS.pathBytes);
    if (!path || pathControls.test(path) || hasIsolatedSurrogate(path)) block(display, "INVALID_PATH", "文件路径必须有效，不能含控制字符。");
    if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path) || path.includes("\\")) block(display, "ABSOLUTE_OR_WINDOWS_PATH", "请使用以 / 分隔的仓库相对路径。");
    if (segments.some(segment => !segment || segment === "." || segment === "..")) block(display, "PATH_TRAVERSAL", "路径不能包含空目录、. 或 ..。");
    if (encoder.encode(path).byteLength > MANIFEST_LIMITS.pathBytes || segments.some(segment => encoder.encode(segment).byteLength > MANIFEST_LIMITS.segmentBytes)) block(display, "PATH_TOO_LONG", "路径最多 1024 字节，单个名称最多 255 字节。");
    if (lower.some(segment => [".git", "node_modules", ".next", "dist", "build"].includes(segment))) block(display, "EXCLUDED_PATH", "请排除 Git 内部目录、依赖和构建输出。");
    if (lower.some((segment, index) => segment === ".github" && lower[index + 1] === "workflows")) block(display, "WORKFLOW_PATH_BLOCKED", "此助手不修改 GitHub 工作流，请使用原生 Git 流程。");
    if (credentialPath(path)) block(display, "CREDENTIAL_FILE_BLOCKED", "此文件名或目录常用于凭据，请排除并检查公开内容。");
    if (change.action === "upsert") {
      const content = change.content ?? "", bytes = encoder.encode(content).byteLength; total += bytes;
      if (bytes > MANIFEST_LIMITS.fileBytes) block(display, "FILE_TOO_LARGE", "单份文件最多 1 MiB。");
      if (unsupportedUploadExtension.test(path) || textControls.test(content) || hasIsolatedSurrogate(content)) block(display, "UNSUPPORTED_TEXT", "仅支持 UTF-8 普通文本，不能上传 ZIP、二进制或控制字符。");
      if (/^\uFEFF?version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/u.test(content)) block(display, "LFS_POINTER_BLOCKED", "此助手不保存 Git LFS 指针或大文件，请使用原生 Git LFS 流程。");
      const reason = secretReason(content); if (reason) block(display, "SUSPECTED_SECRET", `${reason}，请移除实际凭据后再保存。`);
    }
    if (paths.has(key(path))) block(display, "DUPLICATE_PATH", "文件路径重复或仅大小写不同，请保留一项明确变更。");
    else paths.set(key(path), path);
    for (let length = 1; length <= segments.length; length++) {
      const prefix = segments.slice(0, length).join("/"), previous = prefixes.get(key(prefix));
      if (previous !== undefined && previous !== prefix) block(display, "PATH_CASE_COLLISION", "文件或父目录仅大小写不同，请统一名称。");
      else prefixes.set(key(prefix), prefix);
    }
  }
  for (const change of changes) {
    const segments = key(change.path).split("/");
    for (let length = 1; length < segments.length; length++) if (paths.has(segments.slice(0, length).join("/"))) { block(change.path, "PATH_ANCESTOR_CONFLICT", "不能同时保存文件和该文件名下的子路径。"); break; }
  }
  if (total > MANIFEST_LIMITS.totalBytes) block("", "TOTAL_SIZE_EXCEEDED", "一次文件内容总量最多 5 MiB，请拆分保存。");
  return issues.filter((issue, index) => issues.findIndex(previous => previous.path === issue.path && previous.code === issue.code) === index);
}
function readmeTemplate(detail: ProjectDetail): string {
  return `# ${detail.project.name.replace(/[\r\n]+/gu, " ").trim() || "项目名称待填写"}\n\n` +
    `## 作品目标\n\n${detail.project.goal.trim() || "待补充：作品要解决的问题。"}\n\n` +
    `## 本次计划交付\n\n${detail.project.minimumDeliverable.trim() || "待补充：这次至少要做出的完整流程。"}\n\n` +
    `以上是团队空间已保存的目标与计划范围（资料版本 ${detail.project.revision}），请另外核对实际完成情况。\n\n` +
    "## 技术方案\n\n待补充：已实际采用的技术、依赖和版本；计划采用的方案请单独注明。\n\n" +
    "## 本地运行\n\n待补充：运行环境、安装步骤、启动命令和配置项名称。请勿写入密码或密钥。\n\n" +
    "## 实际运行记录\n\n待补充：实际测试日期、环境、步骤、结果与尚未解决的问题。本文草稿不代表运行验收通过。\n\n" +
    "## 使用与赛事提交\n\n待补充：演示方式、材料位置、许可与主办方要求。参赛资格和正式提交结果需分别核对。\n";
}
const operationLabels: Record<GitOperation["status"], { label: string; hint: string }> = {
  draft: { label: "草稿已保存，等待预览", hint: "草稿保存在本站。下一步读取 GitHub 基版本，检查具体文件差异。" },
  ready_for_preview: { label: "差异预览已准备", hint: "核对保存前后内容和目标分支，再明确确认写入。" },
  saving: { label: "正在核对保存结果", hint: "请求已经开始。先核对这个操作的结果，避免重复保存。" },
  saved: { label: "代码版本已保存", hint: "下一步运行作品并记录实际结果；赛事正式提交还需单独完成。" },
  blocked: { label: "保存受阻，需要处理提示", hint: "检查下方文件问题、当前权限和仓库情况，保留草稿后再处理。" },
  failed: { label: "本次保存未完成", hint: "查看错误提示，保留输入，并先核对远端当前状态。" },
  unknown: { label: "保存结果未知", hint: "GitHub 可能已经收到请求。只核对已有操作，确认实际结果后再继续。" },
};
function uncertainSave(reason: unknown): boolean {
  return !(reason instanceof ApiError) || reason.status >= 500 || /UNKNOWN|UNCERTAIN|TIMEOUT|HOLD|LEASE_LOST|IN_PROGRESS/.test(reason.code);
}
export function RepositoryPanel({ detail }: { detail: ProjectDetail }) {
  const base = `/projects/${detail.project.id}`; const status = useApi<SystemStatus>("/system/status"); const binding = useApi<RepositoryBinding | null>(`${base}/repository-binding`); const operations = useApi<GitOperation[]>(`${base}/git-operations`); const action = useAction();
  const [target, setTarget] = useState<RepositoryTarget>({ repositoryId: 0, owner: "", name: "", installationId: 0, appId: 0, defaultBranch: "" }); const [boundConfirmed, setBoundConfirmed] = useState(false); const [disconnect, setDisconnect] = useState(false);
  const [changes, setChanges] = useState<EditChange[]>([]); const [commitMessage, setCommitMessage] = useState(""); const [pr, setPr] = useState(false); const [operation, setOperation] = useState<GitOperation | null>(null); const [signature, setSignature] = useState(""); const [confirm, setConfirm] = useState(false); const [uncertainOperationId, setUncertainOperationId] = useState<string | null>(null);
  const [uploadDirectory, setUploadDirectory] = useState(""); const [importBusy, setImportBusy] = useState(false); const [importError, setImportError] = useState(""); const [importNotice, setImportNotice] = useState(""); const importEpoch = useRef(0); const importLock = useRef(false);
  const [readme, setReadme] = useState(() => readmeTemplate(detail)); const [readmeRevision, setReadmeRevision] = useState(detail.project.revision);
  const archived = detail.project.stage === "archived"; const activeMember = detail.membership.status === "active"; const canBind = !archived && activeMember && detail.membership.role === "manager" && Boolean(status.data?.githubConfigured); const canSave = !archived && activeMember && Boolean(status.data?.githubConfigured); const currentSignature = JSON.stringify({ changes: changes.map(({ uiId: _id, ...change }) => change), message: commitMessage, wantsPullRequest: pr });
  const editorBusy = action.busy || importBusy;
  const fileIssues = useMemo(() => changes.length ? validateTextChanges(changes) : [], [changes]);
  const totalFileBytes = useMemo(() => changes.reduce((total, change) => total + (change.action === "upsert" ? new TextEncoder().encode(change.content ?? "").byteLength : 0), 0), [changes]);
  const existingReadme = changes.find(change => change.path.normalize("NFC").toLowerCase() === "readme.md");
  const needsReconcile = Boolean(operation && (operation.id === uncertainOperationId || ["saving", "unknown"].includes(operation.status)));
  useEffect(() => { importEpoch.current++; importLock.current = false; setImportBusy(false); return () => { importEpoch.current++; importLock.current = false; }; }, [detail.project.id, detail.membership.userId, detail.membership.status, detail.project.stage]);
  const deliveryHref = `/app/projects/${encodeURIComponent(detail.project.id)}/delivery`;
  function draftChanged() { setConfirm(false); if (operation && !signature) setSignature(currentSignature); }
  function announceUpdate() { window.dispatchEvent(new CustomEvent("hackathon:repository-updated", { detail: { projectId: detail.project.id } })); }
  async function refresh() { await Promise.all([binding.reload(), operations.reload()]); announceUpdate(); }
  async function update(path: string, body?: unknown) { const saved = await api<GitOperation>(`${base}/git-operations/${operation!.id}/${path}`, { method: "POST", ...(body === undefined ? {} : { body }) }); setOperation(saved); await operations.reload(); announceUpdate(); return saved; }
  async function importFiles(files: File[]) {
    if (!canSave || editorBusy || needsReconcile || importLock.current || !files.length) return;
    const generation = ++importEpoch.current; importLock.current = true; setImportBusy(true); setImportError(""); setImportNotice("");
    try {
      if (changes.length + files.length > MANIFEST_LIMITS.files) throw new Error("一次最多保存 100 份文件，请减少选择或拆分保存。");
      if (files.some(file => file.size > MANIFEST_LIMITS.fileBytes)) throw new Error("单份文件最多 1 MiB，请减少文件内容后再选择。");
      if (totalFileBytes + files.reduce((total, file) => total + file.size, 0) > MANIFEST_LIMITS.totalBytes) throw new Error("一次文件内容总量最多 5 MiB，请拆分保存。");
      const pathsOnly: FileChange[] = files.map(file => ({ path: uploadDirectory ? `${uploadDirectory}/${file.webkitRelativePath || file.name}` : file.webkitRelativePath || file.name, action: "upsert", content: "" }));
      const pathIssues = validateTextChanges([...changes, ...pathsOnly]);
      if (pathIssues.some(issue => issue.severity === "blocked")) throw new Error(pathIssues.filter(issue => issue.severity === "blocked").map(issue => issue.message).slice(0, 5).join(" "));
      const selected: EditChange[] = [];
      for (const file of files) {
        const relativePath = file.webkitRelativePath || file.name;
        const path = uploadDirectory ? `${uploadDirectory}/${relativePath}` : relativePath;
        if (unsupportedUploadExtension.test(relativePath)) throw new Error("选择中含 ZIP、二进制或其他不支持的文件，请只选择普通 UTF-8 文本。");
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
        catch { throw new Error("选择中有文件无法按 UTF-8 读取，请先转换成 UTF-8 普通文本。"); }
        selected.push({ uiId: operationKey(), path, action: "upsert", content });
      }
      const combined = [...changes, ...selected];
      const issues = validateTextChanges(combined);
      if (issues.some(issue => issue.severity === "blocked")) throw new Error(issues.filter(issue => issue.severity === "blocked").map(issue => issue.message).filter((value, index, values) => values.indexOf(value) === index).slice(0, 5).join(" "));
      if (generation !== importEpoch.current) return;
      draftChanged(); setChanges(combined); setImportNotice(`已检查并加入 ${selected.length} 份文本文件，可在下方修改路径和内容。尚未保存草稿或写入 GitHub。`);
    } catch (reason) { if (generation === importEpoch.current) setImportError(reason instanceof Error ? reason.message : "文件读取未完成，请重新选择。"); }
    finally { if (generation === importEpoch.current) { importLock.current = false; setImportBusy(false); } }
  }
  return <><section className={styles.panel} aria-label="代码与提交操作步骤"><h2>代码与提交，分三步核对</h2><p className={styles.muted}>先保存代码版本，再实际运行作品，最后按主办方要求提交。三个结果各自记录在当前团队空间。</p><nav className={styles.actions} aria-label="当前团队空间交付步骤"><a className={styles.link} href="#repository-save">1 · 保存代码版本</a><a className={styles.link} href="#delivery-verification">2 · 记录实际运行</a><a className={styles.link} href="#official-submission">3 · 核对正式提交</a><Link className={styles.secondary} href={`/github?projectId=${encodeURIComponent(detail.project.id)}`}>看 GitHub 图形教程</Link><Link className={styles.link} href={`/app/projects/${encodeURIComponent(detail.project.id)}`}>返回团队空间 →</Link></nav></section><PresentationProjectEntry projectId={detail.project.id}/><div id="github-authorization"><GitHubConnection detail={detail} binding={binding.data} reloadBinding={refresh}/></div><section className={styles.panel} id="repository-save"><h2>1 · 保存代码版本</h2><p className={styles.muted}>先选择有权限的仓库，准备文件变更，再检查差异并确认。每次操作都会重新核对 GitHub 账号与仓库权限。</p><Feedback error={binding.error ?? operations.error ?? status.error ?? action.error} notice={action.notice}/>{status.data && !status.data.githubConfigured && <p className={styles.notice}>GitHub 服务尚未配置。可以查看历史记录；真实授权、仓库创建和写入需要先完成服务配置。</p>}
    {binding.loading ? <Loading/> : binding.data ? <><p><span className={styles.tag}>{binding.data.status === "bound" ? "当前空间仓库" : "绑定已撤销"}</span><a className={styles.link} target="_blank" rel="noopener noreferrer" href={`https://github.com/${encodeURIComponent(binding.data.owner)}/${encodeURIComponent(binding.data.name)}`}>{binding.data.owner}/{binding.data.name}</a> · 默认分支 {binding.data.defaultBranch}</p><p className={styles.muted}>最近权限检查 {dateText(binding.data.checkedAt)} · 绑定版本 {binding.data.revision}</p></> : !binding.error && <Empty>还没有绑定空间仓库。先在上方连接本人 GitHub 账号，选择或创建仓库，再明确绑定。</Empty>}
    <details><summary className={styles.summary}>高级方式：填写已有仓库的精确身份</summary><p className={styles.muted}>通常在上方从 GitHub 返回的真实仓库列表选择即可。已知完整仓库身份时才使用这个表单，仍须检查真实权限。</p><form className={styles.form} onSubmit={event => { event.preventDefault(); void action.run(async () => { await api(`${base}/repository-binding`, { method: "PUT", body: { target, expectedRevision: binding.data?.revision ?? null } }); setBoundConfirmed(false); await refresh(); }, "真实仓库权限检查与绑定已完成。"); }}>
      <div className={styles.grid}>{([ ["owner", "仓库所属账号"], ["name", "仓库名称"], ["defaultBranch", "已有默认分支"], ["repositoryId", "仓库 ID"], ["installationId", "App 安装 ID"], ["appId", "GitHub App ID"] ] as const).map(([field, label]) => <Field key={field} label={label}><input required disabled={!canBind || editorBusy} type={typeof target[field] === "number" ? "number" : "text"} min={typeof target[field] === "number" ? 1 : undefined} value={target[field] || ""} onChange={event => setTarget({ ...target, [field]: typeof target[field] === "number" ? Number(event.target.value) : event.target.value })}/></Field>)}</div><label className={styles.check}><input type="checkbox" checked={boundConfirmed} onChange={event => setBoundConfirmed(event.target.checked)}/>确认绑定这个已有且已初始化的仓库。服务端会检查真实用户与 App 权限。</label><button className={styles.button} disabled={!canBind || editorBusy || !boundConfirmed}>检查权限并绑定仓库</button></form></details>
    {binding.data?.status === "bound" && <><label className={styles.check}><input type="checkbox" checked={disconnect} onChange={event => setDisconnect(event.target.checked)}/>确认断开本站项目绑定，保留 GitHub 上的仓库和已保存分支。</label><button className={styles.secondary} disabled={!canBind || editorBusy || !disconnect} onClick={() => void action.run(async () => { await api(`${base}/repository-binding`, { method: "DELETE", body: { expectedRevision: binding.data!.revision } }); setDisconnect(false); await refresh(); }, "本站项目绑定已断开。")}>断开项目绑定</button></>}
    <h3>准备文本文件变更</h3><p className={styles.muted}>每个路径相对仓库根目录。支持普通 UTF-8 文本；一次最多 100 份、每份 1 MiB、合计 5 MiB。删除必须明确选择并在预览中再次核对。</p>{detail.membership.role !== "manager" && <p className={styles.muted}>空间成员可保存本人代码变更；仓库绑定由空间管理员操作。</p>}
    <section className={styles.card} aria-label="选择本地文本文件"><h4>从电脑选择文本文件</h4><Field label="这些文件放入仓库的哪个目录" hint="留空放在仓库根目录；例如 src。使用 / 分隔，不填电脑上的完整路径。普通文件选择只带入文件名，子目录可以在下方逐项编辑。"><input value={uploadDirectory} maxLength={1024} disabled={!canSave || editorBusy || needsReconcile} onChange={event => setUploadDirectory(event.target.value)} placeholder="src"/></Field><Field label="选择普通 UTF-8 文本文件" hint="可以多选。ZIP、二进制、Git LFS、依赖目录、构建输出和疑似凭据会被拒绝；通过检查后仍可修改并查看真实差异。"><input type="file" multiple accept={uploadAccept} disabled={!canSave || editorBusy || needsReconcile || changes.length >= MANIFEST_LIMITS.files} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void importFiles(files); }}/></Field>{importBusy && <p role="status" className={styles.muted}>正在读取并检查所选文件…</p>}<Feedback error={importError} notice={importNotice}/></section>
    <details className={styles.card}><summary className={styles.summary}>准备可编辑的项目 README</summary><p className={styles.muted}>草稿使用团队空间资料版本 {readmeRevision} 中的目标与计划交付。技术方案和运行说明尚未提供，请按实际情况补充；加入后仍需保存草稿、查看 GitHub 差异并明确确认。</p>{readmeRevision !== detail.project.revision && <p className={styles.notice}>团队空间资料已更新为版本 {detail.project.revision}。当前草稿保留原内容，可核对后重新生成。</p>}<Field label="README 草稿"><textarea className={styles.mono} rows={16} maxLength={MANIFEST_LIMITS.fileBytes} disabled={!canSave || editorBusy || needsReconcile} value={readme} onChange={event => setReadme(event.target.value)}/></Field><div className={styles.actions}><button type="button" className={styles.secondary} disabled={!canSave || editorBusy || needsReconcile} onClick={() => { setReadme(readmeTemplate(detail)); setReadmeRevision(detail.project.revision); }}>用当前已保存资料重新生成草稿</button><button type="button" className={styles.secondary} disabled={!canSave || editorBusy || needsReconcile || Boolean(existingReadme) || changes.length >= MANIFEST_LIMITS.files || !readme.trim()} onClick={() => { const combined: EditChange[] = [...changes, { uiId: operationKey(), path: "README.md", action: "upsert", content: readme }]; const issues = validateTextChanges(combined); if (issues.some(issue => issue.severity === "blocked")) { setImportError(issues.filter(issue => issue.severity === "blocked").map(issue => issue.message).slice(0, 5).join(" ")); return; } draftChanged(); setChanges(combined); setImportError(""); setImportNotice("README 已加入文件变更，请在下方核对后保存草稿。尚未写入 GitHub。"); }}>将此 README 加入文件变更</button></div>{existingReadme && <p className={styles.notice}>下方已有 README 变更，请直接编辑那一项，避免覆盖本次输入。</p>}</details>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); if (!canSave || editorBusy || needsReconcile || importLock.current || !changes.length || fileIssues.some(issue => issue.severity === "blocked")) return; void action.run(async () => { const saved = await api<GitOperation>(`${base}/git-operations`, { method: "POST", body: { changes: changes.map(({ uiId: _id, ...change }) => change), message: commitMessage, wantsPullRequest: pr, idempotencyKey: operationKey() } }); setOperation(saved); setSignature(currentSignature); setConfirm(false); await operations.reload(); announceUpdate(); }, "变更草稿已保存，尚未写入 GitHub。"); }}>
      <p className={styles.muted}>当前 {changes.length} 份文件变更 · 文本内容 {(totalFileBytes / 1024).toFixed(1)} KiB。只会保存下面明确列出的变更。</p>
      {fileIssues.length > 0 && <div role="alert"><p className={styles.error}>先处理文件问题，再保存草稿。</p><ul className={styles.list}>{fileIssues.slice(0, 20).map((issue, index) => <li className={styles.error} key={`${issue.code}-${index}`}>{issue.path ? `${issue.path}：` : ""}{issue.message}</li>)}</ul>{fileIssues.length > 20 && <p className={styles.error}>还有 {fileIssues.length - 20} 项问题，请修正后继续检查。</p>}</div>}
      {changes.map((change, i) => <section className={styles.card} key={change.uiId}><div className={styles.grid}><Field label={`文件 ${i + 1} · 相对路径`}><input required maxLength={1024} value={change.path} disabled={!canSave || editorBusy} onChange={event => { draftChanged(); setChanges(changes.map(item => item.uiId === change.uiId ? { ...item, path: event.target.value } : item)); }} placeholder="src/example.ts"/></Field><Field label="变更方式"><select value={change.action} disabled={!canSave || editorBusy} onChange={event => { draftChanged(); setChanges(changes.map(item => item.uiId === change.uiId ? event.target.value === "delete" ? { uiId: item.uiId, path: item.path, action: "delete" } : { ...item, action: "upsert", content: "" } : item)); }}><option value="upsert">新增或修改文本</option><option value="delete">显式删除此文件</option></select></Field></div>{change.action === "upsert" && <Field label="完整文件文本"><textarea rows={8} maxLength={MANIFEST_LIMITS.fileBytes} className={styles.mono} disabled={!canSave || editorBusy} value={change.content ?? ""} onChange={event => { draftChanged(); setChanges(changes.map(item => item.uiId === change.uiId ? { ...item, content: event.target.value } : item)); }}/></Field>}<button type="button" className={styles.secondary} disabled={!canSave || editorBusy} onClick={() => { draftChanged(); setChanges(changes.filter(item => item.uiId !== change.uiId)); }}>从草稿移除此变更</button></section>)}<button type="button" className={styles.secondary} disabled={!canSave || editorBusy || changes.length >= MANIFEST_LIMITS.files} onClick={() => { draftChanged(); setChanges([...changes, { uiId: operationKey(), path: "", action: "upsert", content: "" }]); }}>增加文本文件</button><Field label="保存说明"><input required maxLength={1000} disabled={!canSave || editorBusy} value={commitMessage} onChange={event => { draftChanged(); setCommitMessage(event.target.value); }}/></Field><label className={styles.check}><input type="checkbox" disabled={!canSave || editorBusy} checked={pr} onChange={event => { draftChanged(); setPr(event.target.checked); }}/>保存后请求创建 PR，交给团队另行审查和合并。</label><button className={styles.button} disabled={!canSave || editorBusy || needsReconcile || !changes.length || fileIssues.some(issue => issue.severity === "blocked") || binding.data?.status !== "bound"}>保存变更草稿，继续看差异</button></form>
    {operation && <section className={styles.card}><h3>{needsReconcile ? "保存结果待核对" : operationLabels[operation.status].label}</h3><p className={styles.muted}>{needsReconcile ? "请求已经发出，当前页面还无法确认结果。输入已保留，请先核对这个操作，不要重新保存相同变更。" : operationLabels[operation.status].hint}</p><p className={styles.mono}>工作分支 {operation.branch} · 代码版本 {operation.commitSha ?? "尚未确认"}</p><p className={styles.muted}>更新于 {dateText(operation.updatedAt)}</p><details><summary className={styles.muted}>操作标识与错误类别</summary><p className={styles.mono}>{operation.id} · {operation.errorCode ?? "无错误类别"}</p></details>{signature && signature !== currentSignature && <p className={styles.notice}>文件编辑已改变，先另存新草稿；不能确认旧预览。</p>}<div className={styles.actions}><button className={styles.secondary} disabled={!canSave || editorBusy || needsReconcile || operation.status === "saved" || Boolean(signature && signature !== currentSignature)} onClick={() => void action.run(() => update("preview"), "真实基版本和差异预览已载入。")}>读取 GitHub 基版本并预览</button><button className={styles.secondary} disabled={editorBusy} onClick={() => void action.run(async () => { const saved = await update("reconcile"); setUncertainOperationId(["saving", "unknown"].includes(saved.status) ? saved.id : null); setConfirm(false); }, "已核对真实 GitHub 结果，状态以上方返回为准。")}>仅核对已有保存结果</button><button className={styles.secondary} disabled={!canSave || editorBusy || needsReconcile || operation.status !== "saved" || !operation.wantsPullRequest} onClick={() => void action.run(() => update("pull-request"), "PR 状态已核对。")}>继续或核对 PR</button></div>
      {operation.status === "saved" && <div className={styles.actions}><a className={styles.link} href={`https://github.com/${encodeURIComponent(operation.target.owner)}/${encodeURIComponent(operation.target.name)}/tree/${encodeURIComponent(operation.branch)}`} target="_blank" rel="noopener noreferrer">查看 GitHub 已保存分支 ↗</a><Link className={styles.link} href={`${deliveryHref}#delivery-verification`}>下一步：实际运行作品 →</Link></div>}
      {operation.wantsPullRequest && <p className={styles.muted}>PR 状态：{({ not_requested: "尚未请求", pending: "待核对", created: "已创建，是否合并请到 GitHub 核对", failed: "未创建成功", unknown: "结果未知，请先核对" } as const)[operation.pullRequestStatus]}{safeLink(operation.pullRequestUrl) && <> · <a className={styles.link} href={safeLink(operation.pullRequestUrl)!} target="_blank" rel="noopener noreferrer">查看 PR ↗</a></>}</p>}
      {operation.preview && <><p className={styles.muted}>预览读取的基版本：<span className={styles.mono}>{operation.preview.baseHeadSha}</span></p><ul className={styles.list}>{operation.preview.files.map(file => <li key={file.path}><strong>{file.path}</strong> · {({ add: "新增", modify: "修改", delete: "删除", unchanged: "内容未变" } as const)[file.action]}<div className={styles.grid}><details><summary>保存前</summary><pre className={styles.pre}>{file.before ?? "文件不存在"}</pre></details><details><summary>保存后</summary><pre className={styles.pre}>{file.after ?? "文件将删除"}</pre></details></div></li>)}</ul>{operation.preview.issues.map((issue, i) => <p key={i} className={issue.severity === "blocked" ? styles.error : styles.notice}>{issue.path}：{issue.message}</p>)}<label className={styles.check}><input type="checkbox" checked={confirm} disabled={editorBusy || needsReconcile || operation.status !== "ready_for_preview"} onChange={event => setConfirm(event.target.checked)}/>我已检查以上具体增删内容和独立分支，确认保存这个预览版本。</label><button className={styles.button} disabled={!canSave || editorBusy || needsReconcile || !confirm || operation.status !== "ready_for_preview" || operation.preview.issues.some(issue => issue.severity === "blocked") || Boolean(signature && signature !== currentSignature)} onClick={() => void action.run(async () => { try { await update("confirm", { previewHash: operation.preview!.previewHash }); setConfirm(false); } catch (reason) { if (uncertainSave(reason)) { setUncertainOperationId(operation.id); setConfirm(false); } throw reason; } }, "保存请求已返回，具体结果以实际操作状态为准。")}>确认写入预览版本</button></>}
    </section>}
    <details><summary className={styles.summary}>历史操作与草稿取回</summary>{operations.loading && <Loading/>}<ul className={styles.list}>{operations.data?.map(item => <li key={item.id}>{item.message} · {operationLabels[item.status].label}<div className={styles.actions}><button className={styles.secondary} disabled={editorBusy} onClick={() => void action.run(async () => { setOperation(await api(`${base}/git-operations/${item.id}`)); setSignature(""); setConfirm(false); })}>查看与核对这个操作</button>{item.actorId === detail.membership.userId && <button className={styles.secondary} disabled={editorBusy || needsReconcile || ["saving", "unknown"].includes(item.status)} onClick={() => void action.run(async () => { const draft = await api<FileChange[]>(`${base}/git-operations/${item.id}/draft`); setChanges(draft.map(change => ({ ...change, uiId: operationKey() }))); setCommitMessage(item.message); setPr(item.wantsPullRequest); setOperation(null); }, "原草稿已取回，继续编辑后需另存并预览。")}>取回本人草稿</button>}</div></li>)}</ul></details>
  </section></>;
}
