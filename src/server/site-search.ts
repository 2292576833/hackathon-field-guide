import { DomainError } from "../shared/errors.ts";
import { LIBRARY_ARTICLES } from "./library.ts";

export interface SiteSearchDocument {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  /** A source label, not a trust assertion. The caller owns permission/review checks. */
  readonly sourceType: string;
  readonly summary: string;
  readonly body?: string | readonly string[];
  readonly keywords?: readonly string[];
  readonly updatedAt?: string;
  readonly scope: "public" | "current_project";
}
export interface SiteSearchItem {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly sourceType: string;
  readonly scope: SiteSearchDocument["scope"];
  /** A contiguous quote from supplied summary/body, not a generated answer. */
  readonly excerpt: string;
  readonly matchedTerms: readonly string[];
  /** Retrieval ordering only; never a person's ability or a probability. */
  readonly score: number;
  readonly updatedAt?: string;
}
export interface SiteSearchResult {
  readonly items: readonly SiteSearchItem[];
  readonly notices: readonly string[];
  readonly coverage: { readonly searchedDocuments: number; readonly returnedDocuments: number; readonly scope: "provided_documents" };
}

export const SITE_SEARCH_MAX_RESULT_BYTES = 12 * 1024;
const MAX_DOCUMENTS = 512;
const MAX_BODY_CHARACTERS = 16_000;
const MAX_QUERY_CHARACTERS = 2000;
const MAX_TERMS = 32;

interface Intent { readonly terms: readonly string[]; readonly aliases: readonly string[] }
const intents: readonly Intent[] = [
  { terms: ["团队空间", "邀请", "队友"], aliases: ["拉队友", "拉人", "组队", "邀请链接", "链接邀请", "二维码", "邀请队友", "队友", "团队空间", "team space", "teammate", "invite", "qr code"] },
  { terms: ["下一步", "团队空间", "流程"], aliases: ["先干什么", "先做什么", "第一步", "从哪开始", "从哪里开始", "下一步", "全流程", "工作台", "workflow"] },
  { terms: ["GitHub", "仓库", "分支"], aliases: ["git", "github", "仓库", "建仓", "分支", "代码保存", "commit", "push", "clone", "pull request", "repository", "branch"] },
  { terms: ["冲突", "同步", "合并"], aliases: ["git冲突", "合并冲突", "代码冲突", "解决冲突", "冲突", "拉取", "同步", "merge conflict", "merge", "pull", "fetch"] },
  { terms: ["PPT", "模板", "大纲"], aliases: ["ppt", "ppt模板", "ppt模版", "powerpoint", "幻灯片", "slides", "演示文稿", "模板", "模版"] },
  { terms: ["路演", "讲稿"], aliases: ["路演", "讲稿", "介绍词", "台词", "演讲", "pitch", "presentation script"] },
  { terms: ["比赛", "报名", "规则"], aliases: ["报名", "报名链接", "报名截止", "参赛资格", "赛事", "比赛", "黑客松", "hackathon", "registration", "eligibility"] },
  { terms: ["新人", "第一次", "入门"], aliases: ["萌新", "新人", "新手", "第一次", "零基础", "入门", "beginner", "newcomer", "first hackathon"] },
  { terms: ["个人资料", "账号", "经验"], aliases: ["个人资料", "账号设置", "开发经验", "所在城市", "所在地", "可投入时间", "profile", "account"] },
  { terms: ["登录", "验证码", "邮箱"], aliases: ["注册", "登录", "验证码", "邮箱", "login", "sign up", "email"] },
  { terms: ["工具", "资料", "教程"], aliases: ["工具", "资源", "资料", "教程", "tools", "resources", "tutorial"] },
  { terms: ["灵感", "组件", "视觉"], aliases: ["灵感", "审美", "组件", "视觉", "动效", "动画", "ui", "设计参考", "inspiration", "component", "animation"] },
  { terms: ["技能", "技能包", "安装"], aliases: ["skill", "skills", "技能", "技能包", "安装", "套餐", "agent skills", "install"] },
  { terms: ["网站介绍", "第一次", "流程"], aliases: ["网站介绍", "网站怎么用", "怎么用这个网站", "怎么使用网站", "网站指引", "使用指引"] },
  { terms: ["出行", "天气", "备赛"], aliases: ["出行", "天气", "备赛", "行程", "旅行", "weather", "travel"] },
];
const englishStopWords = new Set(["the", "a", "an", "and", "or", "to", "is", "are", "how", "what", "can", "please", "i", "my", "you", "me", "this", "it", "for", "of", "on", "in", "do", "does", "with"]);
const chineseStopWords = ["这个网站", "请问一下", "请问", "怎样", "怎么", "什么", "哪里", "一下", "可以", "需要", "我们", "你们", "帮我", "给我", "一个", "这个", "那个", "网站", "页面", "功能", "操作", "使用", "相关", "信息", "说明", "文档", "内容", "方法", "有没有", "应该", "然后", "的是", "我", "你", "的", "了", "吗", "呢", "是", "有", "要", "在", "去", "和", "与"];

const guideDocuments: readonly SiteSearchDocument[] = [
  { id: "site:journey", title: "参赛路线图：赛前、赛中、赛后怎么走", href: "/journey", sourceType: "网站功能说明", scope: "public", summary: "从找比赛到留下经验的公开树状路线图。",
    body: ["参赛路线图把找比赛、赛前准备、比赛中协作、演示提交、赛后复盘及对应工具串起来。点击行动入口查看说明。", "路线图是通用指南，不保存个人打钩进度；团队真实任务和依赖在团队空间确认。"], keywords: ["参赛流程", "赛前", "赛中", "赛后", "新人", "路线图"] },
  { id: "site:app", title: "团队空间：邀请队友、分工与下一步", href: "/app", sourceType: "网站功能说明", scope: "public", summary: "在我的参赛创建或进入团队空间，一场项目对应一个空间。",
    body: ["进入团队空间先确定作品目标和最小成果；需要多人协作时邀请队友，一个人也能继续。", "空间管理员打开邀请队友窗口，选择可加入人数，生成后及时复制链接或展示二维码。队友登录并明确接受后才加入，复制链接不代表已经加入。", "团队空间指引树依次说明目标邀请、比赛要求、职责时间与计划、执行交接、演示提交、复盘复用。每项说明何时做、怎么核对和下一步入口。", "每个人填写本人时间并自选职责，不确定时可请 AI 提建议。分工和计划草案需要确认生效。任务按真实依赖并行，交出成果后要检查；任务状态和有效检查记录保留在原任务页。"],
    keywords: ["拉队友", "拉人", "链接邀请", "邀请链接", "二维码", "组队", "团队空间", "先干什么", "先做什么", "下一步", "分工", "任务", "工作台"] },
  { id: "site:github", title: "GitHub：建仓、分支、拉取与代码协作", href: "/github", sourceType: "网站功能说明", scope: "public", summary: "用图形说明认识仓库、分支、拉取、保存和合并，查看授权与操作入口。",
    body: ["GitHub 教程说明注册登录、建立仓库、分支协作、同步拉取、查看差异和保存代码。第一次先用小练习理解仓库与 commit。", "遇到 Git 冲突先和文件负责人核对两边修改目的，解决后运行受影响流程。同步最新版本不代表自动合并所有改动。", "网站代操作仓库需要本人授权、预览和明确确认。保存代码、当前版本运行检查、主办方正式提交分别记录。"], keywords: ["git", "github", "拉取", "pull", "fetch", "分支", "建仓", "合并", "冲突", "commit"] },
  { id: "site:events", title: "找比赛：分析、报名线索与主办方原文", href: "/events", sourceType: "网站功能说明", scope: "public", summary: "查看已保存的 DSH 赛事分析，核对报名入口与参加建议。",
    body: ["比赛页展示 DeepSeek Harness 已保存的赛事分析结果、原文链接和有依据的报名入口。分析卡片是未核验线索，不替代主办方规则。", "报名日期、比赛地点、费用和资格可能未知或已变化，请打开主办方原文核对。保存卡片或制定参赛计划不等于已报名。", "制定我的参赛计划结合本人资料提出备赛与出行建议；保存到团队空间的赛事线索仍需成员明确操作。"], keywords: ["比赛", "赛事", "报名", "报名链接", "参赛资格", "黑客松", "hackathon"] },
  { id: "site:resources", title: "工具与资料：已审核资源、收藏与共享", href: "/resources", sourceType: "网站功能说明", scope: "public", summary: "按当前任务寻找已审核工具与参考资料。",
    body: ["工具与资料展示经运营审核发布的资源及使用说明，选择时核对用途、前置条件和来源。", "收藏用途保存在本人账号；主动选择分享到团队空间后，队友才看到对应共享资料。公开资源说明不代表所有外部工具已经接入或免费。"], keywords: ["工具", "资源", "资料", "收藏", "共享", "教程"] },
  { id: "site:inspiration", title: "找灵感：视觉、组件与动效官网", href: "/inspiration", sourceType: "网站功能说明", scope: "public", summary: "查看视觉网站、组件网站与官网说明，按任务选择参考。",
    body: ["灵感页汇集视觉、网页案例、UI 组件与动效官网入口。只有已保存的 DSH 分析才显示生成说明，未分析条目标明等待。", "浏览案例帮助寻找方向，使用代码、素材和组件仍需核对实际许可证及比赛要求。灵感说明不保证某工具适合当前项目。"], keywords: ["灵感", "审美", "视觉", "组件", "ui", "动效", "动画", "设计参考"] },
  { id: "site:skills", title: "AI 技能与任务套餐：先核对，再安装", href: "/skills", sourceType: "网站功能说明", scope: "public", summary: "按实际 AI 工具和要完成的任务选择技能及固定版本。",
    body: ["技能库展示来源、版本、许可和兼容依据；任务套餐分类不等于本场官方赛道。热度不能证明适合你的工作。", "安装前检查准确文件清单、写入目录和冲突，再由本人确认。复制命令、文件写入、客户端加载和示例任务效果是不同状态。"], keywords: ["skill", "skills", "技能", "技能包", "套餐", "安装", "许可"] },
  { id: "site:roadshow", title: "路演与讲稿：案例、注意事项和介绍词", href: "/roadshow", sourceType: "网站功能说明", scope: "public", summary: "参考路演案例，根据本人项目想法准备讲稿与限时演示。",
    body: ["路演页提供案例和注意事项，帮助按问题、方案、真实 Demo、结果及限制组织表达。", "讲稿生成需要本人明确发起，采用团队空间资料也要本人确认。生成记录属于本人账号，分享需主动选择；生成讲稿不等于已经排练。"], keywords: ["路演", "讲稿", "介绍词", "台词", "pitch", "演讲"] },
  { id: "site:ppt", title: "PPT 模板、大纲与制作工具", href: "/ppt", sourceType: "网站功能说明", scope: "public", summary: "查看 PPT 模板与制作工具，按项目内容准备展示大纲。",
    body: ["PPT 页提供模板、制作工具入口和展示大纲生成。准备内容时核对主办方必交材料、演示时长和实际功能。", "生成大纲不代表完成 PPT 文件；还需要制作、打开核对和排练。本人生成内容不会自动分享到团队空间。"], keywords: ["ppt", "ppt模板", "ppt模版", "模板", "模版", "powerpoint", "幻灯片", "大纲"] },
  { id: "site:account", title: "个人资料与账号：经验、城市和登录邮箱", href: "/app/account", sourceType: "网站功能说明", scope: "public", summary: "维护本人参赛画像和账号资料，为后续建议提供实际情况。",
    body: ["账号页可以填写是否首次参赛、开发经验、所在城市和可投入时间。提供真实情况可帮助生成适合自己的备赛、出行和路演建议。", "登录与注册使用本人填写的邮箱接收验证码；不要把验证码或邮箱授权码放到公开资料、代码或团队共享信息中。", "首次登录的网站指引有六步，完成后可以手动重看。个人资料、测评、行程和讲稿不自动共享。"], keywords: ["个人资料", "账号", "注册", "登录", "验证码", "邮箱", "开发经验", "城市", "第一次参赛"] },
  { id: "site:participation", title: "个人参赛计划：备赛、出行与天气建议", href: "/participation", sourceType: "网站功能说明", scope: "public", summary: "基于选定比赛和本人资料准备专属计划，再自行核对真实条件。",
    body: ["从比赛卡片的计划入口选择比赛，根据首次参赛、经验、所在城市和可投入时间准备备赛与出行建议。", "天气、报名、交通与费用需要核对实际来源；AI 计划是建议，不能证明已经购买、报名或完成准备。计划保存在本人账号，分享需要明确操作。"], keywords: ["参赛计划", "备赛", "出行", "天气", "行程", "个人准备"] },
];

/** Static authored content only. No filesystem, private storage or external fetch. */
export function getSiteSearchDocuments(): readonly SiteSearchDocument[] {
  return [
    ...LIBRARY_ARTICLES.map(article => ({ id: `library:${article.slug}`, title: article.title, href: `/library/${article.slug}`,
      sourceType: "本站原创资料", scope: "public" as const, summary: article.summary, body: [...article.body, ...article.steps], updatedAt: article.updatedAt,
      keywords: [article.category, ...(article.slug === "github-team-workflow" ? ["git", "github", "拉取", "同步", "pull", "冲突", "合并"] : [])] })),
    ...guideDocuments.map(document => ({ ...document, body: Array.isArray(document.body) ? [...document.body] : document.body, keywords: document.keywords ? [...document.keywords] : undefined })),
  ];
}

function normalizeText(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
function hasTerm(text: string, term: string): boolean {
  if (/^[a-z0-9 ._+-]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "u").test(text);
  }
  return text.includes(term);
}
interface QueryTerm { value: string; weight: number }
function queryTerms(query: string): QueryTerm[] {
  const normalized = normalizeText(query), terms = new Map<string, number>();
  const add = (value: string, weight: number) => { const term = normalizeText(value); if (term.length >= 2 && term.length <= 60) terms.set(term, Math.max(terms.get(term) ?? 0, weight)); };
  for (const intent of intents) {
    const matched = intent.aliases.filter(alias => hasTerm(normalized, normalizeText(alias)));
    if (!matched.length) continue;
    matched.forEach(value => add(value, 3)); intent.terms.forEach(value => add(value, 1));
  }
  for (const word of normalized.match(/[a-z][a-z0-9._+-]{0,59}/g) ?? []) if (!englishStopWords.has(word)) add(word, 2);
  let han = normalized;
  for (const stop of chineseStopWords) han = han.split(stop).join(" ");
  for (const phrase of han.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    add(phrase.slice(0, 60), 2);
    if (phrase.length > 3) for (let index = 0; index < Math.min(phrase.length - 1, 20); index++) add(phrase.slice(index, index + 2), 1);
  }
  return [...terms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en")).slice(0, MAX_TERMS).map(([value, weight]) => ({ value, weight }));
}

/** A deliberately narrow allowlist of real read/navigation destinations. */
function safeHref(value: string, scope: SiteSearchDocument["scope"]): string | null {
  if (typeof value !== "string" || value.length > 600 || !value.startsWith("/") || value.startsWith("//")
    || /[\\\u0000-\u0020\u007f]/.test(value) || /%(?![\da-f]{2})/i.test(value) || /%25/i.test(value)) return null;
  let url: URL;
  try { url = new URL(value, "https://site.invalid"); } catch { return null; }
  if (url.origin !== "https://site.invalid" || url.pathname !== value.split(/[?#]/, 1)[0]) return null;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  if (/[\\\u0000-\u0020\u007f?#:]/.test(path) || path.includes("//") || path.split("/").some(part => part === "." || part === "..")) return null;
  // A percent-encoded slash may turn one opaque id into another route.
  if (/%(?:2f|5c|2e|3f|23)/i.test(url.pathname)) return null;
  const exact = new Set(["/", "/journey", "/events", "/resources", "/inspiration", "/skills", "/library", "/github", "/roadshow", "/ppt", "/app", "/app/account", "/participation"]);
  const segment = "[\\p{L}\\p{N}_@.-]{1,160}";
  const publicDetail = new RegExp(`^/(?:library|events|resources|skills)/${segment}$|^/skills/bundles/${segment}$`, "u").test(path);
  const privateDetail = scope === "current_project" && new RegExp(`^/app/projects/${segment}(?:/(?:rules|team|assessment|plan|delivery|resources|retrospective))?$`, "u").test(path);
  if (!exact.has(path) && !publicDetail && !privateDetail) return null;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.length > 1) return null;
  if (keys.length) {
    const key = keys[0]!, parameter = url.searchParams.get(key)!;
    if (key === "projectId" && ["/roadshow", "/ppt", "/github"].includes(path)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(parameter)) return null;
    } else if (key === "event" && path === "/participation") {
      if (!/^[a-f0-9]{64}$/.test(parameter)) return null;
    } else if (key === "versionId" && /^\/skills\/[^/]+$/.test(path)) {
      if (!/^[A-Za-z0-9_@.+-]{1,180}$/.test(parameter)) return null;
    } else return null;
  }
  if (url.hash && !/^#[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/.test(url.hash)) return null;
  return value;
}

function clip(value: string, maxCharacters: number, maxBytes = maxCharacters * 4): string {
  let result = "", bytes = 0, characters = 0;
  for (const character of value) {
    const length = Buffer.byteLength(character, "utf8");
    if (characters >= maxCharacters || bytes + length > maxBytes) break;
    result += character; bytes += length; characters++;
  }
  return result;
}
interface PreparedDocument { document: SiteSearchDocument; title: string; summary: string; segments: string[]; keywordText: string }
function prepare(document: SiteSearchDocument): PreparedDocument | null {
  if (!document || !["public", "current_project"].includes(document.scope) || typeof document.id !== "string" || !document.id.trim()
    || document.id.length > 160 || /[\u0000-\u001f\u007f]/.test(document.id) || typeof document.title !== "string" || !document.title.trim()
    || typeof document.sourceType !== "string" || !document.sourceType.trim() || typeof document.summary !== "string" || !safeHref(document.href, document.scope)) return null;
  const title = clip(document.title.trim(), 180, 700), summary = clip(document.summary.trim(), 1024, 3200);
  const bodies = typeof document.body === "string" ? [document.body] : Array.isArray(document.body) ? document.body.slice(0, 64) : [];
  const segments = [summary]; let remaining = MAX_BODY_CHARACTERS;
  for (const body of bodies) {
    if (!remaining) break;
    if (typeof body !== "string") continue;
    const text = body.slice(0, remaining).trim(); remaining -= Math.min(body.length, remaining);
    if (text) segments.push(text);
  }
  const keywords = Array.isArray(document.keywords) ? document.keywords.slice(0, 32).filter(value => typeof value === "string").map(value => value.slice(0, 60)).join(" ") : "";
  return { document: { ...document, title, summary, sourceType: clip(document.sourceType.trim(), 80, 240) }, title: normalizeText(title), summary: normalizeText(summary), segments, keywordText: normalizeText(keywords) };
}

function excerpt(segments: readonly string[], terms: readonly QueryTerm[]): string {
  const scored = segments.filter(Boolean).map((text, index) => ({ text, index, score: terms.reduce((sum, term) => sum + (hasTerm(normalizeText(text), term.value) ? term.weight : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = scored[0]?.text ?? "";
  let start = 0;
  if (selected.length > 280) {
    // Map NFKC-expanded matches back to original offsets, never quote normalized text.
    let comparable = "", offset = 0;
    const originalOffsets: number[] = [];
    for (const character of selected) {
      const normalized = character.normalize("NFKC").toLowerCase();
      comparable += normalized;
      for (let index = 0; index < normalized.length; index++) originalOffsets.push(offset);
      offset += character.length;
    }
    const position = terms.map(term => comparable.indexOf(term.value)).filter(value => value >= 0).sort((a, b) => a - b)[0];
    if (position !== undefined) start = Math.max(0, originalOffsets[position]! - 40);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(selected[start]!)) start--;
  }
  return clip(selected.slice(start), 280, 760);
}

/** Only searches the explicit authorized corpus; source text is untrusted data.
 * No query becomes a tool instruction, SQL statement, file path or model call. */
export function searchSiteDocuments(query: string, documents: readonly SiteSearchDocument[] = getSiteSearchDocuments()): SiteSearchResult {
  if (typeof query !== "string" || query.length > MAX_QUERY_CHARACTERS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query)) {
    throw new DomainError("INVALID_SITE_SEARCH_QUERY", "站内搜索关键词无效或过长，请缩短后重试。", { status: 422 });
  }
  if (!Array.isArray(documents)) throw new DomainError("INVALID_SITE_SEARCH_CORPUS", "站内搜索资料集合无效。", { status: 422 });
  const notices: string[] = [], prepared: PreparedDocument[] = [], seen = new Set<string>();
  for (const document of documents.slice(0, MAX_DOCUMENTS)) {
    const value = prepare(document);
    if (value && !seen.has(value.document.id)) { seen.add(value.document.id); prepared.push(value); }
  }
  if (documents.length > MAX_DOCUMENTS) notices.push("本次只搜索有界资料集合，不能据此认为已检索全部站内信息。");
  const terms = queryTerms(query);
  const ranked: { value: PreparedDocument; matchedTerms: string[]; score: number }[] = [];
  if (terms.length) for (const value of prepared) {
    const body = normalizeText(value.segments.join("\n"));
    const matches = terms.map(term => ({ term, weight: (hasTerm(value.title, term.value) ? 8 : 0) + (hasTerm(value.summary, term.value) ? 4 : 0)
      + (hasTerm(value.keywordText, term.value) ? 9 : 0) + (hasTerm(body, term.value) ? 1 : 0) })).filter(match => match.weight > 0);
    if (!matches.length) continue;
    ranked.push({ value, matchedTerms: matches.map(match => match.term.value).slice(0, 12), score: matches.reduce((sum, match) => sum + match.weight * match.term.weight, 0) });
  }
  ranked.sort((a, b) => b.score - a.score || a.value.document.id.localeCompare(b.value.document.id, "en"));
  const items: SiteSearchItem[] = ranked.slice(0, 6).map(candidate => {
    const document = candidate.value.document;
    return { id: document.id, title: document.title, href: document.href, sourceType: document.sourceType, scope: document.scope,
      excerpt: excerpt(candidate.value.segments, terms), matchedTerms: candidate.matchedTerms, score: candidate.score,
      ...(document.updatedAt && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(document.updatedAt) && Number.isFinite(Date.parse(document.updatedAt)) ? { updatedAt: document.updatedAt } : {}) };
  }).filter(item => item.excerpt);
  if (!items.length) notices.push(terms.length ? "这次没有找到相关的已提供站内资料。请换更具体的关键词；没有命中不代表全站不存在该信息。" : "请提供具体关键词，例如邀请队友、Git 冲突、PPT 模板或报名。");
  const coverage = { searchedDocuments: prepared.length, returnedDocuments: items.length, scope: "provided_documents" as const };
  const result: SiteSearchResult = { items, notices, coverage };
  // Bound the entire object that the coordinator quotes to the model, metadata included.
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > SITE_SEARCH_MAX_RESULT_BYTES) notices.push("相关资料较多，按引用长度上限保留最相关结果。");
  while (items.length && Buffer.byteLength(JSON.stringify(result), "utf8") > SITE_SEARCH_MAX_RESULT_BYTES) {
    items.pop();
    coverage.returnedDocuments = items.length;
  }
  return result;
}
