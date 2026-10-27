import type { ModuleAssistantKey } from "./model.ts";
import { moduleAssistant } from "./registry.ts";

/** 只把注册表声明的既有 sectionPath 拼出来；助手绝不新增导航入口。 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/;

/** 只把注册表声明的既有页面拼出来；助手绝不新增导航入口。 */
export function safeModuleAssistantSectionHref(eventId: string, key: ModuleAssistantKey, projectId?: string): string | null {
  if (typeof eventId !== "string" || !ID.test(eventId)) return null;
  let href = moduleAssistant(key).sectionPath.replace("{eventId}", encodeURIComponent(eventId));
  if (href.includes("{projectId}")) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return null;
    href = href.replace("{projectId}", encodeURIComponent(projectId));
  }
  if (href.includes("{")) return null;
  const allowed = href.startsWith("/organizers/workspace/") || href.startsWith("/competitions/") || href.startsWith("/app/projects/");
  return allowed && !href.includes("//") ? href : null;
}

export const MODULE_ASSISTANT_PANEL_TITLE = "本模块助手（DSH）";
export const MODULE_ASSISTANT_PANEL_READS = "它读了什么：仅本场本模块的授权只读事实，只读范围逐次列出。";
export const MODULE_ASSISTANT_PANEL_COPY_HINT = "只生成草稿、核对清单、摘要或去重提示；请自行复制或采用，助手不会替你执行。";
export const MODULE_ASSISTANT_PANEL_MANUAL_NOTE = "助手不可用时，本模块的人工流程照常可用；平台不设强制次数上限。";
export const MODULE_ASSISTANT_PANEL_SWITCH = "比赛设置 → 模块助手（默认全开，可逐模块关闭，属内部运营项）。";
