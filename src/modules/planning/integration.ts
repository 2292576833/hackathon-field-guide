import type { PlanningRepository } from "./ports.ts";

/** Server-only fact lookup for M02 workflow composition after M02 performs project authorization. */
export function createPlanningWorkflowReader(repository: PlanningRepository) {
  return {
    async hasConfirmedPlanOrManualTasks(projectId: string): Promise<boolean> {
      const state = await repository.read(projectId);
      if (!state) return false;
      const current = state.plans.find(plan => plan.id === state.currentPlanVersionId);
      return current?.status === "applied" || state.tasks.some(task => task.status !== "cancelled");
    },
  };
}
