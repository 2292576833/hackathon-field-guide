import type { SpaceGuideStep, SpaceGuideStepId } from "./guide-tree.ts";

export type SpaceStepState = {
  status: "recorded" | "review" | "error" | "loading" | "unknown" | "current" | "pending";
  label: string;
  allRecorded: boolean;
  current: boolean;
};

/** Aggregate only the guide's authorized facts. A recorded guide step is not a
 * completed task or an accepted submission; its UI deliberately says “已有记录”.
 * Empty, unread, loading and failed facts can never imply a successful stage. */
export function deriveSpaceStepState(step: Pick<SpaceGuideStep, "id" | "nodes">, currentStepId: SpaceGuideStepId): SpaceStepState {
  const facts = step.nodes.map(node => node.fact.status);
  const current = step.id === currentStepId;
  const allRecorded = facts.length > 0 && facts.every(status => status === "recorded");
  const result = (status: SpaceStepState["status"], label: string): SpaceStepState => ({ status, label, allRecorded, current });
  if (facts.includes("error")) return result("error", "读取失败，需重试");
  if (facts.includes("loading")) return result("loading", "正在读取");
  if (facts.length === 0 || facts.includes("unknown")) return result("unknown", "信息待读取");
  if (facts.includes("review")) return result("review", "需要复核");
  if (allRecorded) return result("recorded", "已有记录");
  return current ? result("current", "建议现在做") : result("pending", "按需准备与核对");
}

/** Accept both stage IDs and the exact action IDs used by the guide/todo entry.
 * Unknown IDs do not silently open an unrelated stage. */
export function findSpaceStepForNode(steps: readonly SpaceGuideStep[], nodeId: string): SpaceGuideStep | undefined {
  return steps.find(step => step.id === nodeId || step.nodes.some(node => node.id === nodeId));
}
