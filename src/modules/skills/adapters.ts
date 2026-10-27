import type { AgentAdapter, AgentId } from "./domain.ts";
const evidenceUrl = "https://github.com/vercel-labs/skills/blob/87a266971d9460a3d2606075b8e91edc83325472/src/agents.ts";
const definitions: readonly [AgentId, string, string][] = [
  ["codex", "Codex", ".agents/skills"], ["claude-code", "Claude Code", ".claude/skills"], ["cursor", "Cursor", ".agents/skills"],
  ["github-copilot", "GitHub Copilot", ".agents/skills"], ["gemini-cli", "Gemini CLI", ".agents/skills"], ["opencode", "OpenCode", ".agents/skills"],
  ["windsurf", "Windsurf", ".windsurf/skills"], ["cline", "Cline", ".agents/skills"],
];
export const AGENT_ADAPTERS: readonly AgentAdapter[] = definitions.map(([id, name, projectDirectory]) => ({ id, name, version: "1", projectDirectory, evidenceUrl, evidenceKind: "installer_declared", checkedAt: "2026-10-08T14:19:23.000Z", clientVersion: null, liveCompatibility: "not_tested", loadingGuide: `在 ${name} 中打开授权项目，重启会话并查看技能列表。若未发现，先核对客户端版本及其官方技能设置；文件存在不能证明已加载。本站尚未对该客户端完成任务实测。` }));
export function adapter(id: string): AgentAdapter | null { return AGENT_ADAPTERS.find(value => value.id === id) ?? null; }
