import type { PptTool } from "./domain.ts";

/**
 * Official pages read on 2026-10-09. Feature verification only; no price or
 * material-license claims. Each URL is both the source and the product entry.
 * PowerPoint: templates, real-time collaboration, Speaker Coach.
 * Google Slides: co-editing, sharing controls, revision history, import.
 * Canva Presentations: templates, browser/mobile editing, collaboration.
 * Gamma: prompt/outline/file creation, manual edits, PowerPoint/PDF export.
 */
export const PPT_TOOLS: readonly PptTool[] = Object.freeze([
  Object.freeze({
    id: "powerpoint",
    name: "Microsoft PowerPoint",
    url: "https://www.microsoft.com/en-us/microsoft-365/powerpoint",
    description: "制作与编辑幻灯片，提供可定制模板、实时协作和演讲排练工具。",
    useWhen: "团队已经使用 Office，想逐页细调内容，并为正式路演排练讲述节奏。",
    note: "桌面、网页和 AI 功能的可用性，以当前套餐与账号权限为准。",
    verifiedAt: "2026-10-09",
  }),
  Object.freeze({
    id: "google-slides",
    name: "Google Slides",
    url: "https://workspace.google.com/products/slides/",
    description: "支持多人同时编辑、评论、共享权限和版本历史，也可导入 PowerPoint 演示文稿。",
    useWhen: "队友需要异地一起改稿，希望在同一份演示文稿上分工、评论与换版本。",
    note: "共享前确认查看与编辑权限；录制和 AI 等功能以当前套餐为准。",
    verifiedAt: "2026-10-09",
  }),
  Object.freeze({
    id: "canva",
    name: "Canva Presentations",
    url: "https://www.canva.com/presentations/",
    description: "提供演示模板、视觉编辑与实时协作，可在浏览器或移动设备编辑和演示。",
    useWhen: "内容已经写清楚，想借助模板统一版式，让产品截图和文字更容易读。",
    note: "所选模板、素材与 AI 功能的可用性和使用条件，以官方说明为准。",
    verifiedAt: "2026-10-09",
  }),
  Object.freeze({
    id: "gamma",
    name: "Gamma",
    url: "https://gamma.app/",
    description: "可从提示词、大纲或文件制作演示内容，再手动或用 AI 修改，并导出为 PowerPoint 或 PDF。",
    useWhen: "已有逐页大纲，想先获得视觉草稿，再逐条核对事实并调整演示结构。",
    note: "生成内容需复核，导出后检查排版；可用功能与额度以当前套餐为准。",
    verifiedAt: "2026-10-09",
  }),
]);
