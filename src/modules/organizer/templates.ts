import type { EventTemplate } from "./model.ts";

export const ORGANIZER_TEMPLATES: readonly EventTemplate[] = [
  { key: "online", version: 1, name: "线上黑客松", description: "个人报名、自愿组队、线上提交与人工评审。", format: "online", timezone: "Asia/Shanghai",
    modules: { registration: true, teams: true, icebreaking: false, judging: true, schedule: true, accommodation: false, mealVouchers: false },
    registration: { reviewRequired: false, capacity: null }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null } },
  { key: "onsite", version: 1, name: "线下黑客松", description: "人工审核、现场行程和餐券；住宿可按需要开启。", format: "onsite", timezone: "Asia/Shanghai",
    modules: { registration: true, teams: true, icebreaking: true, judging: true, schedule: true, accommodation: false, mealVouchers: true },
    registration: { reviewRequired: true, capacity: 100 }, teams: { mode: "mixed", minSize: 1, maxSize: 5, locksAt: null } },
  { key: "practice", version: 1, name: "校园 / 社区练习赛", description: "少量参赛者，自愿组队，优先交流和反馈。", format: "onsite", timezone: "Asia/Shanghai",
    modules: { registration: true, teams: true, icebreaking: true, judging: false, schedule: true, accommodation: false, mealVouchers: false },
    registration: { reviewRequired: false, capacity: 30 }, teams: { mode: "free", minSize: 1, maxSize: 4, locksAt: null } },
];
export function listOrganizerTemplates(): readonly EventTemplate[] { return structuredClone(ORGANIZER_TEMPLATES); }
