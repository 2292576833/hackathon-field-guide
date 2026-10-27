export interface PreflightIssue {
  /** 对应界面上的字段，便于就地定位。 */
  field: string;
  label: string;
  message: string;
  /** block = 服务器一定会拒绝，先不要发请求；warn = 服务器接受，但值得本人再看一眼。 */
  severity: "block" | "warn";
}
export interface DraftLink { label: string; url: string }
export interface DraftFile { name: string; url: string; sizeBytes: string; sha256: string; mediaType: string }

/**
 * 正式提交前的字段级自检：一次列出**全部**问题，有阻断项就不要发请求。
 *
 * 依据：竞品把"提交前把问题一次讲清、不通过就不发请求"做成独立一步
 * （HackerTrip CLI `lib/submit-event.mjs` L123–144、L174–182，`lib/publish-work.mjs` L107–115）。
 * 我们此前是"撞到第一个错误就抛"，一次只能发现一个问题。
 *
 * 纪律：这里**只做派生的重复检查**，服务器校验仍然是唯一权威——
 * 规则与 `validation.ts` 的 `materials()` 保持一致，任何不一致都以服务器为准。
 */

const maxTitle = 160, maxDescription = 12000, maxLabel = 100, maxUrl = 2048, maxName = 180, maxMediaType = 120;
const maxItems = 12, maxFileBytes = 1073741824, maxTotalBytes = 24000;
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

const lengthOf = (value: string): number => Buffer.byteLength(value, "utf8");

function textIssue(field: string, label: string, value: string, max: number, required: boolean): PreflightIssue | null {
  if (controlCharacters.test(value)) return { field, label, message: `${label}含有不可见控制字符，请重新输入。`, severity: "block" };
  if (required && !value.trim()) return { field, label, message: `请填写${label}。`, severity: "block" };
  if (value.length > max) return { field, label, message: `${label}最多 ${max} 个字符，当前 ${value.length} 个。`, severity: "block" };
  return null;
}
function urlIssue(field: string, label: string, value: string): PreflightIssue | null {
  if (!value.trim()) return { field, label, message: `请填写${label}。`, severity: "block" };
  if (value.length > maxUrl) return { field, label, message: `${label}最多 ${maxUrl} 个字符。`, severity: "block" };
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return { field, label, message: `${label}必须是以 https:// 开头的地址。`, severity: "block" };
    if (url.username || url.password) return { field, label, message: `${label}不能包含账号或密码。`, severity: "block" };
  } catch { return { field, label, message: `${label}不是完整地址，请检查拼写。`, severity: "block" }; }
  return null;
}

export function submissionPreflight(input: { title: string; description: string; links: readonly DraftLink[]; files: readonly DraftFile[] }): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const add = (issue: PreflightIssue | null) => { if (issue) issues.push(issue); };

  add(textIssue("title", "作品名称", input.title, maxTitle, true));
  add(textIssue("description", "作品说明", input.description, maxDescription, true));

  // 只校验真正会提交的链接（界面允许留着空行）。
  const links = input.links.filter(link => link.url.trim());
  if (input.links.length > maxItems) issues.push({ field: "links", label: "作品链接", message: `最多提供 ${maxItems} 个链接，当前 ${input.links.length} 个。`, severity: "block" });
  links.forEach((link, index) => {
    add(textIssue(`links.${index}.label`, `第 ${index + 1} 个链接的名称`, link.label, maxLabel, true));
    add(urlIssue(`links.${index}.url`, `第 ${index + 1} 个链接地址`, link.url));
  });
  if (links.length > 1) {
    const seen = new Set<string>();
    for (const link of links) {
      const key = link.url.trim();
      if (seen.has(key)) issues.push({ field: "links", label: "作品链接", message: `同一个地址重复出现：${key}。请确认是否需要保留两条。`, severity: "warn" });
      seen.add(key);
    }
  }

  if (input.files.length > maxItems) issues.push({ field: "files", label: "文件元数据", message: `最多提供 ${maxItems} 份文件元数据，当前 ${input.files.length} 份。`, severity: "block" });
  input.files.forEach((file, index) => {
    const position = `第 ${index + 1} 份文件`;
    add(textIssue(`files.${index}.name`, `${position}名称`, file.name, maxName, true));
    add(urlIssue(`files.${index}.url`, `${position}地址`, file.url));
    add(textIssue(`files.${index}.mediaType`, `${position}类型`, file.mediaType, maxMediaType, true));
    const size = file.sizeBytes.trim();
    if (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size)) || Number(size) > maxFileBytes) issues.push({ field: `files.${index}.sizeBytes`, label: `${position}大小`, message: `${position}大小必须是不超过 1 GB（1073741824 字节）的整数字节数。`, severity: "block" });
    if (!/^[a-fA-F0-9]{64}$/.test(file.sha256.trim())) issues.push({ field: `files.${index}.sha256`, label: `${position}哈希`, message: `${position}哈希必须是 64 位 SHA-256（十六进制）。`, severity: "block" });
  });
  if (input.files.length > 1) {
    const seen = new Set<string>();
    for (const file of input.files) {
      const key = file.sha256.trim().toLowerCase();
      if (key.length === 64 && seen.has(key)) issues.push({ field: "files", label: "文件元数据", message: `同一个文件哈希出现了两次（${key.slice(0, 12)}…）。请确认是否重复登记。`, severity: "warn" });
      seen.add(key);
    }
  }

  // 与服务器同口径的总长度检查：按会被保存的规范形状计算。
  const normalized = { title: input.title.trim(), description: input.description.trim(),
    links: links.map(link => ({ label: link.label.trim(), url: link.url.trim() })),
    files: input.files.map(file => ({ name: file.name.trim(), url: file.url.trim(), sizeBytes: Number(file.sizeBytes), sha256: file.sha256.trim().toLowerCase(), mediaType: file.mediaType.trim() })) };
  let total: number;
  try { total = lengthOf(JSON.stringify(normalized)); } catch { total = 0; }
  if (total > maxTotalBytes) issues.push({ field: "materials", label: "材料总长度", message: `材料合计约 ${total} 字节，超过 ${maxTotalBytes} 字节（24 KB）上限，请缩短作品说明。`, severity: "block" });

  return issues;
}

/** 有阻断项就不要发请求；提示项只提醒，不拦。 */
export function blockingIssues(issues: readonly PreflightIssue[]): PreflightIssue[] { return issues.filter(issue => issue.severity === "block"); }
