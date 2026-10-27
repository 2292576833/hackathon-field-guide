/**
 * event-site · 主办方专属页（规划 35）。
 *
 * P1a（类型与规则核心，无数据库、无 UI、无模型调用）：
 * - 类型与上限：./model.ts
 * - 区块注册表、默认模块集、删除建议：./blocks.ts
 * - 校验与归一（闸门）：./validation.ts
 * - 规则提醒与优先级派生（0 成本体检）：./policy.ts
 *
 * P1b（存储与服务层，仍然没有 UI、没有模型调用）：
 * - 持久适配与短码：./postgres.ts（只读写 080 的两张表）
 * - 权限、状态机、发布门槛、审计、只读投影：./service.ts
 * - HTTP 工厂（路径由根注册）：./handlers.ts
 *
 * P2（生成与建议，纯模块层，仍然没有路由、没有 UI、没有数据库写入）：
 * - 固定 system 提示、结构化意图、用户输入拼接：./prompt.ts
 * - 模型 Port（只定义）、generatePage、suggestForSpec：./generation.ts
 *
 * P3（批注打标与 AI 组件编辑模式，纯模块层，仍然没有路由、没有 UI、没有数据库写入）：
 * - 批注模型与校验、applyAnnotations、refineContainer、两套 system 提示：./annotation.ts
 *
 * P4（草稿历史与版本回退，模块层，仍然没有路由注册、没有 UI、没有模型调用）：
 * - 历史的存储适配、保留窗口与摘要列表：./history.ts
 * - saveDraft 同事务留痕、listRevisions、restoreRevision：./service.ts（追加，不改既有方法行为）
 * - 两条 handler：./handlers.ts（路径由根注册）
 *
 * 边界写在 README.md；接入需求写在 docs/协作/交付/event-site.md 的 NEEDS_INTERFACE。
 */
export * from "./model.ts";
export * from "./blocks.ts";
export * from "./validation.ts";
export * from "./policy.ts";
export * from "./postgres.ts";
export * from "./service.ts";
export * from "./handlers.ts";
export * from "./prompt.ts";
export * from "./generation.ts";
export * from "./annotation.ts";
export * from "./history.ts";
export * from "./templates.ts";
export * from "./designs.ts";
