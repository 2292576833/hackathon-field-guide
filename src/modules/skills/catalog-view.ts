import { AGENT_ADAPTERS } from "./adapters.ts";
import type { AgentId, Skill, SkillVersion, Track } from "./domain.ts";

export const SKILL_DIRECTIONS: Record<Track, string> = { general: "通用参赛", game: "游戏作品", film: "影视作品", ai_agent: "AI Agent 作品" };
export const SKILL_TASKS: Record<string, string> = { delivery: "写启动说明与交付文档", planning: "梳理想法和作品范围", design: "设计并实现页面", game: "做可玩的游戏原型", media: "处理视频和媒体", agent: "搭建 AI Agent 或工具服务", testing: "测试页面与演示" };
export interface SkillContext { agentId: AgentId | ""; track: Track | ""; category: string; search: string }

export function readSkillContext(params: { get: (key: string) => string | null }): SkillContext {
  const clean = (key: string, limit: number) => (params.get(key) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, limit);
  const agentId = clean("agentId", 80), track = clean("track", 80);
  return { agentId: AGENT_ADAPTERS.some(agent => agent.id === agentId) ? agentId as AgentId : "", track: Object.hasOwn(SKILL_DIRECTIONS, track) ? track as Track : "", category: clean("category", 80), search: clean("search", 200) };
}

export function skillContextQuery(context: SkillContext): string {
  const query = new URLSearchParams();
  for (const key of ["agentId", "track", "category", "search"] as const) if (context[key].trim()) query.set(key, context[key].trim());
  return query.toString();
}

/** A declaration identifies an install target; it never proves a client loaded or ran the skill. */
export function declaresSkillTarget(version: SkillVersion, agentId: string): boolean {
  return version.compatibility.some(value => value.agentId === agentId && value.status === "format_and_path_declared");
}

export function filterPublishedSkills(skills: readonly Skill[], query: { agentId?: string; track?: string; category?: string; search?: string }): Skill[] {
  const search = (query.search ?? "").trim().slice(0, 200).toLowerCase();
  return skills.map(skill => ({ ...skill, versions: skill.versions.filter(version => version.status === "published" && (!query.agentId || declaresSkillTarget(version, query.agentId))) })).filter(skill => skill.versions.length > 0 && (!query.track || skill.tracks.includes(query.track as Track)) && (!query.category || skill.category === query.category) && (!search || `${skill.name} ${skill.title} ${skill.summary}`.toLowerCase().includes(search)));
}
