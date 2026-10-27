import type { PlanningInput, PlanningIssue, PlanningResourceRef, PlanningTask } from "./types.ts";

export function validatePinnedResourceRefs(task: PlanningTask): PlanningIssue[] {
  if (task.resourceContentRefs === undefined) return [];
  const refs = task.resourceContentRefs;
  if (!Array.isArray(refs) || refs.some(ref => !ref || typeof ref.resourceId !== "string" || !task.resourceRefs.includes(ref.resourceId) || !Number.isSafeInteger(ref.version) || ref.version < 1) || new Set(refs.map(ref => ref.resourceId)).size !== refs.length) return [{ code: "INVALID_RESOURCE_CONTENT_REFS", severity: "error", taskIds: [task.id], message: "固定资源引用需要本任务中的唯一资源 ID 与有效内容版本。", suggestion: "由服务端重新读取审核资源版本，不能提交自定版本。" }];
  return [];
}

/** Current public heads are facts, while pins remain the unchanged historical basis. */
export function reviewResourceContentRefs(tasks: readonly PlanningTask[], input: PlanningInput): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  for (const task of tasks) {
    if (task.status === "cancelled" || !Array.isArray(task.resourceRefs)) continue;
    const pins = new Map((Array.isArray(task.resourceContentRefs) ? task.resourceContentRefs : []).filter((ref): ref is PlanningResourceRef => !!ref && typeof ref.resourceId === "string").map(ref => [ref.resourceId, ref.version]));
    for (const id of task.resourceRefs) {
      const pin = pins.get(id);
      const heads = input.resourceContentVersions;
      const known = !!heads && Object.prototype.hasOwnProperty.call(heads, id);
      const current = known ? heads![id] : undefined;
      const add = (code: string, message: string) => issues.push({ code, severity: "risk", taskIds: [task.id], resourceIds: [id], ...(pin === undefined ? {} : { referenceVersion: pin }), ...(current === undefined ? {} : { currentVersion: current }), message, suggestion: "保留历史依据并复核；若采用新版，请显式请求刷新此资源并确认学习、接入和验收影响。" });
      if (pin === undefined) add("RESOURCE_CONTENT_VERSION_UNCONFIRMED", "旧引用没有固定内容版本，无法证明当时使用的资源依据；不能把当前版本回填为历史事实。");
      if (!known) add("RESOURCE_CONTENT_REVIEW_UNAVAILABLE", "尚未获得该资源当前公开内容版本，原计划依据需要复核。");
      else if (current === null || !input.approvedResourceIds.includes(id)) add("HISTORICAL_RESOURCE_UNAVAILABLE", "该资源当前未审核或已下架，保留历史 ID 与内容版本，不作为新推荐。");
      else if (!Number.isSafeInteger(current) || current! < 1) issues.push({ code: "INVALID_RESOURCE_VERSION_FACT", severity: "error", taskIds: [task.id], resourceIds: [id], message: "当前公开资源版本事实不合法。", suggestion: "检查 M09 事实适配，不得用编辑修订号替代公开内容版本。" });
      else if (pin !== undefined && current !== pin) add("RESOURCE_CONTENT_VERSION_CHANGED", "资源 ID 相同但公开内容版本已改变，旧计划的估算与使用条件需要复核。");
    }
  }
  return issues;
}

export function hasResourceReviewRisk(issues: readonly PlanningIssue[]): boolean {
  return issues.some(issue => ["RESOURCE_CONTENT_VERSION_UNCONFIRMED", "RESOURCE_CONTENT_REVIEW_UNAVAILABLE", "RESOURCE_CONTENT_VERSION_CHANGED", "HISTORICAL_RESOURCE_UNAVAILABLE"].includes(issue.code));
}
