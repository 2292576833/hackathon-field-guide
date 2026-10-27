import type { ResourceService } from "../modules/resources/service.ts";
import { RESOURCE_CATEGORIES, type Resource } from "../modules/resources/domain.ts";
import type { SkillsService } from "../modules/skills/service.ts";
import { assertVersion, type Skill, type SkillVersion } from "../modules/skills/domain.ts";
import { SKILL_DIRECTIONS, SKILL_TASKS } from "../modules/skills/catalog-view.ts";
import type { createDiscoveryService, DiscoveryCard } from "./discovery.ts";
import type { createInspirationService } from "./inspiration.ts";
import type { InspirationCandidate, InspirationItem } from "./inspiration-catalog.ts";
import type { SiteSearchDocument } from "./site-search.ts";

export interface SiteSearchSourceDependencies {
  resources: Pick<ResourceService, "list">;
  discoveries: Pick<ReturnType<typeof createDiscoveryService>, "list">;
  skills: Pick<SkillsService, "list">;
  inspiration: Pick<ReturnType<typeof createInspirationService>, "snapshot">;
}

const limits = { resources: 100, discoveries: 60, skills: 100, inspiration: 60 } as const;
const inspirationCategories = { visual: "视觉参考", websites: "网站案例", components: "UI 组件", motion: "动效参考" } as const;
const registrationStates = { open: "来源显示报名开放，仍需向主办方核对", closed: "来源显示报名已截止", unknown: "报名截止尚未核实" } as const;
const eventStates = { future: "来源中的开赛日期在分析日期之后", past: "来源中的开赛日期已过", unknown: "开赛日期尚未核实" } as const;
const participationStates = { consider: "符合条件时可考虑", caution: "参加前需谨慎核对条件", insufficient_info: "信息不足，暂不能判断" } as const;
const keywords = (...values: (string | readonly string[])[]) => [...new Set(values.flatMap(value => typeof value === "string" ? [value] : value).filter(Boolean))].sort();
const safeId = (value: string) => typeof value === "string" && /^[\p{L}\p{N}_.@-]{1,150}$/u.test(value) && value !== "." && value !== "..";
const instant = (value: string) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

function resourceDocument(item: Resource): SiteSearchDocument | null {
  if (item.publicationStatus !== "published" || item.externalLinkBlocked || !safeId(item.id)) return null;
  const category = RESOURCE_CATEGORIES.find(value => value.id === item.type)?.name ?? item.type;
  return {
    id: `resource:${item.id}`, title: item.name, href: `/resources/${encodeURIComponent(item.id)}`,
    sourceType: "人工审核公开资源", summary: item.summary,
    body: [
      `资源类别：${category}；公开内容版本：${item.version}；公开修订：${item.revision}。`,
      `适用于：${item.suitableFor}`, `不适用于：${item.notSuitableFor}`,
      ...item.quickStart.map((value, index) => `开始使用 ${index + 1}：${value}`),
      `费用说明：${item.costNote}`, `许可说明：${item.licenseNote}`,
      `费用核验状态：${item.costType}；许可核验状态：${item.licenseStatus}；链接状态：${item.linkStatus}。`,
      `官网：${item.officialUrl}`,
    ],
    keywords: keywords(item.name, category, item.type, item.stageTags, item.useTags, item.stackTags, item.prerequisites),
    updatedAt: item.updatedAt, scope: "public",
  };
}

function discoveryDocument(item: DiscoveryCard): SiteSearchDocument | null {
  // The public list owns active/withdrawn visibility; dates never remove a card.
  if (item.provider !== "dsh" || item.verificationStatus !== "unverified" || !/^[a-f0-9]{64}$/.test(item.id)) return null;
  const registration = item.registrationWindow;
  const event = item.eventWindow;
  const participation = item.participation;
  return {
    id: `discovery:${item.id}`, title: item.title,
    href: `/participation?event=${encodeURIComponent(item.id)}`,
    sourceType: "DSH赛事线索（未人工核验）", summary: item.summary,
    body: [
      "这是 DSH 已保存的公开赛事线索，未经人工核验，不等于项目已确认的官方规则。",
      `线索修订：${item.revision}。报名或开赛状态只代表已保存分析，不保证当前仍可报名。`,
      `报名状态：${registrationStates[registration?.status ?? "unknown"]}。报名截止：${registration?.closesAt ?? registration?.closesOn ?? "未知"}。`,
      ...(registration?.evidence.map(value => `报名依据：${value}`) ?? []),
      `开赛时间：${event?.startsAt ?? event?.startsOn ?? "未知"}；${eventStates[event?.status ?? "unknown"]}。`,
      ...(event?.evidence.map(value => `开赛依据：${value}`) ?? []),
      ...item.analysis.fit.map(value => `适合尝试的情况：${value}`),
      ...item.analysis.risks.map(value => `风险：${value}`),
      ...item.analysis.preparation.map(value => `准备建议：${value}`),
      ...item.analysis.unknowns.map(value => `尚未核实：${value}`),
      ...(participation ? [`条件性建议：${participationStates[participation.recommendation]}；${participation.reason}`,
        ...participation.suitableFor.map(value => `条件性适用：${value}`), ...participation.cautionFor.map(value => `需谨慎：${value}`)] : []),
      ...(item.registration ? [`来源提取的报名入口：${item.registration.url}；依据：${item.registration.evidence}`] : ["尚未确认独立报名入口，请从赛事原文核对。"]),
      ...item.sources.map(value => `来源${value.sourceKind === "indexed_excerpt" ? "（仅搜索引用，未读取全文）" : ""}：${value.title}；${value.url}；${value.excerpt}`),
    ],
    keywords: keywords(item.title, "黑客松", "比赛", "报名", "DSH赛事线索"),
    updatedAt: item.lastAnalyzedAt, scope: "public",
  };
}

function skillDocument(skill: Skill, version: SkillVersion): SiteSearchDocument | null {
  if (!safeId(skill.id) || !safeId(version.id) || version.skillId !== skill.id || version.status !== "published") return null;
  try { assertVersion(version); } catch { return null; }
  const category = SKILL_TASKS[skill.category] ?? skill.category;
  return {
    id: `skill:${version.id}`, title: `${skill.title}（固定版本 ${version.version}）`,
    href: `/skills/${encodeURIComponent(skill.id)}?versionId=${encodeURIComponent(version.id)}`,
    sourceType: "公开技能固定版本（兼容与任务尚未实测）", summary: skill.summary,
    body: [
      `技能任务：${category}；资源方向：${skill.tracks.map(value => SKILL_DIRECTIONS[value]).join("、")}。资源方向不等于主办方官方赛道。`,
      `固定版本：${version.id}；仓库：${version.repository}；commit：${version.commit}；内容哈希：${version.contentHash}。`,
      `许可：${version.license.spdx}；${version.license.sourceUrl}。保留原作者许可与声明。`,
      "兼容信息只声明路径与格式，客户端加载与示例任务尚未实测。本目录不能确认用户已安装或安装成功。",
      ...[...version.compatibility].sort((a, b) => a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)
        .map(value => `工具声明：${value.agentId}；${value.limitation}；依据：${value.evidenceUrl}`),
      `适用于：${skill.tutorial.suitableFor}`, `限制：${skill.tutorial.limitations}`,
      ...skill.prerequisites.map(value => `前置条件：${value}`), ...skill.permissions.map(value => `权限需求：${value}`),
      ...skill.tutorial.steps.map((value, index) => `操作 ${index + 1}：${value}`),
      ...skill.tutorial.checkOutput.map(value => `自行检查：${value}`),
    ],
    keywords: keywords(skill.name, skill.title, category, skill.category, skill.tracks.map(value => SKILL_DIRECTIONS[value]), version.compatibility.map(value => value.agentId)),
    updatedAt: version.reviewedAt, scope: "public",
  };
}

function inspirationDocument(item: InspirationCandidate, analyzed?: InspirationItem): SiteSearchDocument | null {
  if (!safeId(item.id)) return null;
  const category = inspirationCategories[item.category];
  return {
    id: `inspiration:${item.id}`, title: item.name, href: "/inspiration",
    sourceType: analyzed ? "DSH灵感官网分析" : "灵感候选（尚未完成DSH分析）",
    summary: analyzed ? analyzed.description : "尚未完成 DSH 分析，仅保留候选站点身份、分类和等待状态。",
    body: analyzed
      ? [`分类：${category}；内容类别：${item.contentType}。`, `适用情况：${analyzed.useWhen}`, `使用说明：${analyzed.usageNote}`,
        `官网：${item.url}`, ...analyzed.evidenceUrls.map(value => `官网依据：${value}`)]
      : [`分类：${category}；内容类别：${item.contentType}。`, `候选官网：${item.url}`, "尚无 DSH 用途分析，不推断费用、许可、组件能力或使用效果。"],
    keywords: keywords(item.name, category, item.category, item.tags),
    ...(analyzed ? { updatedAt: analyzed.checkedAt } : {}), scope: "public",
  };
}

/** Only existing public read ports are accepted. This reader performs no fetch,
 * write, worker initialization, installation, filesystem or private-data read.
 * Bounds cover output; the current skills/snapshot APIs have no paging input. */
export function createSiteSearchSourceReader(deps: SiteSearchSourceDependencies) {
  async function readResources() {
    const documents: SiteSearchDocument[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 2; page++) {
      const result = await deps.resources.list({ limit: 50, ...(cursor ? { cursor } : {}) });
      for (const item of result.items.slice(0, 50)) { const document = resourceDocument(item); if (document) documents.push(document); }
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    return documents.slice(0, limits.resources);
  }
  async function readDiscoveries() {
    const result = await deps.discoveries.list({ limit: limits.discoveries });
    return result.items.slice(0, limits.discoveries).flatMap(item => { const document = discoveryDocument(item); return document ? [document] : []; });
  }
  async function readSkills() {
    const result = await deps.skills.list();
    const documents: SiteSearchDocument[] = [];
    for (const skill of result.items) {
      for (const version of skill.versions) {
        const document = skillDocument(skill, version);
        if (document) documents.push(document);
        if (documents.length >= limits.skills) return documents;
      }
    }
    return documents;
  }
  async function readInspiration() {
    const result = await deps.inspiration.snapshot();
    const documents = new Map<string, SiteSearchDocument>();
    for (const item of result.items.slice(0, limits.inspiration)) {
      // Date-only editorial seed text is not a saved successful DSH analysis.
      const analyzed = result.status.kind === "dsh" && instant(item.checkedAt) && item.evidenceUrls.length > 0
        && [item.description, item.useWhen, item.usageNote].every(value => typeof value === "string" && value.trim()) ? item : undefined;
      const document = inspirationDocument(item, analyzed);
      if (document) documents.set(document.id, document);
    }
    for (const item of result.pendingItems.slice(0, limits.inspiration)) {
      if (documents.size >= limits.inspiration) break;
      const document = inspirationDocument(item);
      if (document && !documents.has(document.id)) documents.set(document.id, document);
    }
    return [...documents.values()];
  }
  return {
    async readPublicDocuments(): Promise<readonly SiteSearchDocument[]> {
      // Propagate a failed source read: final answer validation must not pretend
      // that an unavailable source was successfully checked for withdrawal.
      // The caller may own a savepoint. Finish every read before returning an
      // error so no sibling SQL continues after that scope has been released.
      const results = await Promise.allSettled([readResources(), readDiscoveries(), readSkills(), readInspiration()]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      const groups = results.map(result => result.status === "fulfilled" ? result.value : []);
      const unique = new Map<string, SiteSearchDocument>();
      for (const document of groups.flat()) if (!unique.has(document.id)) unique.set(document.id, document);
      return [...unique.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    },
  };
}
