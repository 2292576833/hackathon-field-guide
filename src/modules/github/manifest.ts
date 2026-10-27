import { createHash } from "node:crypto";
import { DomainError } from "../../shared/errors.ts";
import type { FileChange, FileIssue, FilePreview, GitHead, GitPreview, GitTreeEntry, Manifest, ManifestEntry } from "./types.ts";

/** Limits count UTF-8 bytes, rather than UTF-16 JavaScript characters. */
export const MANIFEST_LIMITS = Object.freeze({ files: 100, fileBytes: 1_048_576, totalBytes: 5_242_880, pathBytes: 1_024, segmentBytes: 255 });

const excludedSegments = new Set([".git", "node_modules", ".next", "dist", "build"]);
const regularModes = new Set(["100644", "100755"]);
const pathControls = /[\u0000-\u001f\u007f-\u009f]/u;
const textControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const unsupportedUploadExtension = /\.(?:zip|7z|rar|tar|gz|bz2|xz|pdf|png|jpe?g|gif|webp|ico|bmp|tiff?|mp[34]|wav|ogg|avi|mov|woff2?|ttf|otf|exe|dll|bin|wasm|sqlite3?|db|docx?|xlsx?|pptx?|p12|pfx)$/iu;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** JSON object keys are sorted; array order remains significant. Non-JSON values are rejected. */
export function hashInput(value: unknown): string {
  const stack = new Set<object>();
  function canonical(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || stack.has(item)) {
      throw new DomainError("INVALID_HASH_INPUT", "用于确认的输入必须是无循环的 JSON 数据。");
    }
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new DomainError("INVALID_HASH_INPUT", "用于确认的输入必须是普通 JSON 数据。");
    }
    stack.add(item);
    let result: string;
    if (Array.isArray(item)) {
      // Match JSON's handling of absent/undefined array positions, without accepting functions.
      result = `[${Array.from(item, entry => entry === undefined ? "null" : canonical(entry)).join(",")}]`;
    } else {
      const object = item as Record<string, unknown>;
      result = `{${Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
    }
    stack.delete(item);
    return result;
  }
  return sha256(canonical(value));
}

function hasIsolatedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function issue(path: string, code: string, message: string): FileIssue {
  return { path, code, message, severity: "blocked" };
}

function safeIssuePath(path: unknown): string {
  if (typeof path !== "string" || pathControls.test(path) || hasIsolatedSurrogate(path)) return "";
  return path.normalize("NFC").slice(0, MANIFEST_LIMITS.pathBytes);
}

function caseKey(path: string): string {
  return path.normalize("NFC").toLowerCase().normalize("NFC");
}

function regularMode(mode: unknown): "100644" | "100755" | null {
  return mode === "100644" || mode === "100755" ? mode : null;
}

function credentialPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  return segments.some(segment => segment === ".ssh" || segment === ".aws")
    || /^\.env(?:\.|$)/u.test(name)
    || /^(?:\.npmrc|\.pypirc|\.netrc|_netrc|id_rsa|id_dsa|id_ecdsa|id_ed25519|kubeconfig|application_default_credentials\.json)$/u.test(name)
    || /^(?:credentials?|secrets?)(?:\.(?:json|ini|ya?ml|toml))?$/u.test(name)
    || /^service[-_]?account(?:[-_.].*)?\.json$/u.test(name)
    || /\.(?:pem|key|p12|pfx|keystore)$/u.test(name);
}

/** Only generic reasons leave this function; never include the matched credential value. */
function secretReason(content: string): string | null {
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u.test(content)) return "疑似私钥内容";
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/u.test(content)) return "疑似 GitHub 访问令牌";
  if (/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,255}\b/u.test(content)) return "疑似服务访问密钥";
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(content)) return "疑似云访问凭据";
  if (/\b(?:AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{16,255})\b/u.test(content)) return "疑似服务访问令牌";
  // Bound the scheme/credentials so a large ordinary line cannot cause quadratic scanning.
  if (/[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]{1,1024}:[^\s/@]{1,4096}@/iu.test(content)) return "疑似带密码的连接地址";
  if (/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/u.test(content)) return "疑似身份访问令牌";
  const assignments = /["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|password|passwd|private[_-]?key)["']?\s*[:=]\s*(?:["'`]([^"'`\r\n]{12,})["'`]|([^\s,;\r\n]{12,}))/giu;
  for (const match of content.matchAll(assignments)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (/^(?:process\.env\.|import\.meta\.env\.|Deno\.env\.|os\.environ|os\.getenv|env\(|getenv\(|\$\{|\{\{|<)/iu.test(value)) continue;
    if (/^(?:your[_-]|replace[_-]|example[_-]|placeholder|changeme|change-me|not[_-]a[_-]real|dummy[_-]|test[_-]|undefined|null|true|false)/iu.test(value)) continue;
    if (/^\*+$|^x+$/iu.test(value)) continue;
    // Obvious function/property expressions refer to configuration; quoted values are literals.
    if (match[1] === undefined && /^[A-Za-z_$][\w$]*(?:\.[\w$]+|\([^\r\n]*\))+$/u.test(value)) continue;
    return "疑似明文密码或密钥配置";
  }
  return null;
}

function normalizePath(raw: unknown, issues: FileIssue[]): string | null {
  const display = safeIssuePath(raw);
  if (typeof raw !== "string" || raw.length === 0 || pathControls.test(raw) || hasIsolatedSurrogate(raw)) {
    issues.push(issue(display, "INVALID_PATH", "文件路径必须是有效的相对文本路径，不能含控制字符。"));
    return null;
  }
  const path = raw.normalize("NFC");
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path) || path.includes("\\")) {
    issues.push(issue(display, "ABSOLUTE_OR_WINDOWS_PATH", "请使用以 / 分隔的仓库相对路径，不使用绝对路径或 Windows 路径。"));
    return null;
  }
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    issues.push(issue(display, "PATH_TRAVERSAL", "路径不能包含空目录、. 或 ..，请重新选择文件。"));
    return null;
  }
  if (Buffer.byteLength(path, "utf8") > MANIFEST_LIMITS.pathBytes || segments.some(segment => Buffer.byteLength(segment, "utf8") > MANIFEST_LIMITS.segmentBytes)) {
    issues.push(issue(display, "PATH_TOO_LONG", "文件路径超过 1024 字节或单个名称超过 255 字节，请缩短路径。"));
    return null;
  }
  const lowerSegments = segments.map(segment => segment.toLowerCase());
  if (lowerSegments.some(segment => excludedSegments.has(segment))) {
    issues.push(issue(path, "EXCLUDED_PATH", "此路径属于 Git 内部文件、依赖或构建输出，请排除后继续。"));
  }
  if (lowerSegments.some((segment, index) => segment === ".github" && lowerSegments[index + 1] === "workflows")) {
    issues.push(issue(path, "WORKFLOW_PATH_BLOCKED", "首版不修改 GitHub 工作流，请通过有权限的原生流程处理。"));
  }
  if (credentialPath(path)) issues.push(issue(path, "CREDENTIAL_FILE_BLOCKED", "此文件名或目录通常用于保存凭据，请排除并检查公开内容。"));
  return path;
}

/** Validation is pure: the original changes are retained by the draft store. */
export function validateManifest(changes: FileChange[]): Manifest {
  const issues: FileIssue[] = [];
  const entries: ManifestEntry[] = [];
  const signatures: Array<{ path: string; action: string; contentHash: string; contentProvided: boolean; mode: string | null }> = [];
  let totalBytes = 0;
  if (!Array.isArray(changes)) return { entries, totalBytes, inputHash: hashInput([]), issues: [issue("", "INVALID_MANIFEST", "请提供文件变更列表。")] };
  if (changes.length === 0) issues.push(issue("", "EMPTY_MANIFEST", "请选择至少一份要新增、修改或明确删除的文件。"));
  if (changes.length > MANIFEST_LIMITS.files) issues.push(issue("", "FILE_COUNT_EXCEEDED", "一次最多保存 100 份文件，请拆分保存。"));
  for (const change of changes) {
    if (!change || typeof change !== "object") {
      issues.push(issue("", "INVALID_FILE_CHANGE", "每项文件变更都需要路径和明确的操作。"));
      continue;
    }
    const path = normalizePath(change.path, issues);
    const contentHash = typeof change.content === "string" ? sha256(change.content) : sha256("");
    signatures.push({ path: path ?? safeIssuePath(change.path), action: typeof change.action === "string" ? change.action : "invalid", contentHash, contentProvided: change.content !== undefined, mode: typeof change.mode === "string" ? change.mode : null });
    if (change.action !== "upsert" && change.action !== "delete") {
      issues.push(issue(path ?? "", "INVALID_FILE_ACTION", "文件操作必须明确为保存或删除。"));
      continue;
    }
    if (change.mode !== undefined && !regularModes.has(change.mode)) issues.push(issue(path ?? "", "UNSUPPORTED_FILE_MODE", "只支持普通文件和可执行普通文件。"));
    let bytes = 0;
    if (change.action === "upsert") {
      if (path && unsupportedUploadExtension.test(path)) issues.push(issue(path, "UNSUPPORTED_UPLOAD_TYPE", "此助手仅保存普通文本，不支持压缩包、二进制、文档附件或大文件。"));
      if (typeof change.content !== "string") issues.push(issue(path ?? "", "TEXT_CONTENT_REQUIRED", "保存文件需要完整的 UTF-8 文本内容。"));
      else {
        bytes = Buffer.byteLength(change.content, "utf8");
        totalBytes += bytes;
        if (bytes > MANIFEST_LIMITS.fileBytes) issues.push(issue(path ?? "", "FILE_TOO_LARGE", "单份文件最多 1 MiB，请使用其他保存方式。"));
        if (textControls.test(change.content) || hasIsolatedSurrogate(change.content)) issues.push(issue(path ?? "", "UNSUPPORTED_TEXT", "只支持有效 UTF-8 普通文本，不能含二进制、控制字符或孤立代理字符。"));
        if (/^\uFEFF?version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/u.test(change.content)) issues.push(issue(path ?? "", "LFS_POINTER_BLOCKED", "此助手不保存 Git LFS 指针或大文件，请使用原生 Git LFS 流程。"));
        const reason = secretReason(change.content);
        if (reason) issues.push(issue(path ?? "", "SUSPECTED_SECRET", `${reason}，请移除实际凭据并重新预览。`));
      }
    } else if (change.content !== undefined || change.mode !== undefined) {
      issues.push(issue(path ?? "", "DELETE_HAS_CONTENT", "删除操作不附带文件内容或执行权限，请明确确认删除。"));
    }
    if (path !== null) entries.push({ path, action: change.action, bytes, contentHash, mode: regularMode(change.mode) ?? "100644" });
  }
  if (totalBytes > MANIFEST_LIMITS.totalBytes) issues.push(issue("", "TOTAL_SIZE_EXCEEDED", "一次文件内容总量最多 5 MiB，请拆分保存。"));
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.action.localeCompare(right.action));
  const paths = new Map<string, string>();
  const prefixes = new Map<string, string>();
  for (const entry of entries) {
    const key = caseKey(entry.path);
    const seen = paths.get(key);
    if (seen !== undefined) issues.push(issue(entry.path, seen === entry.path ? "DUPLICATE_PATH" : "PATH_CASE_COLLISION", "文件路径重复或仅大小写不同，请保留一项明确变更。"));
    else paths.set(key, entry.path);
    const segments = entry.path.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = segments.slice(0, length).join("/");
      const existing = prefixes.get(caseKey(prefix));
      if (existing !== undefined && existing !== prefix) issues.push(issue(entry.path, "PATH_CASE_COLLISION", "文件路径或父目录仅大小写不同，请统一名称后重新预览。"));
      else prefixes.set(caseKey(prefix), prefix);
    }
  }
  for (const entry of entries) {
    const segments = caseKey(entry.path).split("/");
    for (let length = 1; length < segments.length; length += 1) {
      if (paths.has(segments.slice(0, length).join("/"))) {
        issues.push(issue(entry.path, "PATH_ANCESTOR_CONFLICT", "同一次变更不能同时选择文件和该文件名下的子路径。"));
        break;
      }
    }
  }
  signatures.sort((left, right) => {
    const a = JSON.stringify(left), b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { entries, totalBytes, inputHash: hashInput(signatures), issues };
}

function uniqueIssues(issues: FileIssue[]): FileIssue[] {
  return issues.filter((entry, index) => issues.findIndex(candidate => candidate.path === entry.path && candidate.code === entry.code) === index);
}

/** A preview is tied to its exact input and base commit/tree; it never selects unmentioned files. */
export function buildPreview(input: { manifest: Manifest; changes: FileChange[]; head: GitHead; tree: GitTreeEntry[]; beforeByPath: Record<string, string>; createdAt: string }): GitPreview {
  const checked = validateManifest(input.changes);
  const issues = [...checked.issues];
  if (input.manifest.inputHash !== checked.inputHash || input.manifest.totalBytes !== checked.totalBytes || hashInput(input.manifest.entries) !== hashInput(checked.entries)) {
    issues.push(issue("", "MANIFEST_MISMATCH", "文件已发生变化，请重新生成并确认预览。"));
  }
  const changesByPath = new Map(input.changes.filter(change => change && typeof change.path === "string").map(change => [change.path.normalize("NFC"), change]));
  const treeByPath = new Map<string, GitTreeEntry[]>();
  const treeByCase = new Map<string, GitTreeEntry[]>();
  const remotePrefixes = new Map<string, Set<string>>();
  for (const entry of input.tree) {
    const path = entry.path.normalize("NFC");
    treeByPath.set(path, [...(treeByPath.get(path) ?? []), entry]);
    const key = caseKey(path);
    treeByCase.set(key, [...(treeByCase.get(key) ?? []), entry]);
    // Account for implicit parent paths even if an adapter's tree fixture omits directory entries.
    const segments = entry.path.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = segments.slice(0, length).join("/");
      const prefixKey = caseKey(prefix);
      const variants = remotePrefixes.get(prefixKey) ?? new Set<string>();
      variants.add(prefix);
      remotePrefixes.set(prefixKey, variants);
    }
  }
  const files: FilePreview[] = [];
  for (const entry of checked.entries) {
    const change = changesByPath.get(entry.path);
    if (!change) continue;
    const candidates = treeByPath.get(entry.path) ?? [];
    const remote = candidates[0];
    const segments = entry.path.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = segments.slice(0, length).join("/");
      const aliases = treeByCase.get(caseKey(prefix)) ?? [];
      const variants = remotePrefixes.get(caseKey(prefix)) ?? new Set<string>();
      if ([...variants].some(alias => alias !== prefix) || aliases.length > 1) {
        issues.push(issue(entry.path, "REMOTE_PATH_COLLISION", "远端存在仅大小写或 Unicode 形式不同的路径，请先通过原生 Git 工具核对。"));
      }
      if (length < segments.length && aliases.some(alias => alias.type !== "tree" || !["040000", "40000"].includes(alias.mode))) {
        issues.push(issue(entry.path, "REMOTE_ANCESTOR_NOT_DIRECTORY", "远端父路径是文件、符号链接或子模块，不能在它下面保存文件。"));
      }
    }
    const descendants = input.tree.some(remoteEntry => caseKey(remoteEntry.path).startsWith(`${caseKey(entry.path)}/`));
    if (remote?.type === "tree" || descendants) issues.push(issue(entry.path, "REMOTE_PATH_IS_DIRECTORY", "此远端路径是目录，不能通过文件保存或删除操作覆盖目录。"));
    else if (remote && (remote.type !== "blob" || !regularModes.has(remote.mode))) issues.push(issue(entry.path, "UNSUPPORTED_REMOTE_FILE", "此远端路径是符号链接、子模块或其他不支持的文件类型。"));
    if (entry.action === "delete" && !remote) issues.push(issue(entry.path, "DELETE_TARGET_MISSING", "要删除的文件在当前基版本中不存在，请重新检查预览。"));

    const isRegular = remote?.type === "blob" && regularModes.has(remote.mode);
    let before: string | null = null;
    const beforeMode = isRegular ? regularMode(remote.mode) : null;
    if (isRegular) {
      const hasBefore = Object.prototype.hasOwnProperty.call(input.beforeByPath, remote.path);
      if (!hasBefore || typeof input.beforeByPath[remote.path] !== "string") issues.push(issue(entry.path, "REMOTE_CONTENT_MISSING", "未能读取当前版本文件内容，请重新加载后预览。"));
      else {
        before = input.beforeByPath[remote.path];
        if (textControls.test(before) || hasIsolatedSurrogate(before)) {
          issues.push(issue(entry.path, "UNSUPPORTED_REMOTE_TEXT", "远端文件不是支持的普通 UTF-8 文本，请使用原生 Git 工具处理。"));
          before = null;
        } else if (secretReason(before) || credentialPath(entry.path)) {
          issues.push(issue(entry.path, "REMOTE_SUSPECTED_SECRET", "远端文件含疑似凭据，预览已隐藏内容，请先通过安全方式处理。"));
          before = null;
        }
      }
    }
    let after = entry.action === "delete" || typeof change.content !== "string" ? null : change.content;
    if (after !== null && (secretReason(after) || credentialPath(entry.path) || textControls.test(after) || hasIsolatedSurrogate(after))) after = null;
    const afterMode = entry.action === "delete" ? null : regularMode(change.mode) ?? beforeMode ?? "100644";
    const action = entry.action === "delete" ? "delete" : !remote ? "add" : before === after && beforeMode === afterMode ? "unchanged" : "modify";
    files.push({ path: entry.path, action, before, after, beforeMode, afterMode });
  }
  if (!files.some(file => file.action !== "unchanged")) issues.push(issue("", "NO_CHANGES", "所选文件与当前版本一致，没有需要保存的变更。"));
  const preview = { inputHash: checked.inputHash, baseHeadSha: input.head.commitSha, baseTreeSha: input.head.treeSha, files, issues: uniqueIssues(issues), createdAt: input.createdAt };
  return { ...preview, previewHash: hashInput(preview) };
}
