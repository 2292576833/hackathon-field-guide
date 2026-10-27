import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import type { ProjectsService } from "../modules/projects/index.ts";
import type { ApplicationConfig } from "./config.ts";
import { PostgresAiLedger } from "./ai-jobs.ts";
import { createBudgetedModel } from "./ai.ts";
import { createDshJsonModel } from "./dsh-model.ts";
import { createNavigatorService, type NavigatorSiteSources } from "./navigator.ts";
import { createPersonalWorkspace } from "./personal-workspace.ts";

/** All website conversations use this one DSH path, independently of the
 * provider selected for structured project jobs. No HTTP/static fallback. */
export function createDshWebsiteChat(deps: { config: ApplicationConfig; database: DatabasePort;
  projects: Pick<ProjectsService, "getProject">; clock: Clock; ids: IdGenerator; sessions?: ReturnType<typeof createPersonalWorkspace>; siteSources?: NavigatorSiteSources }) {
  const config = deps.config.dsh;
  const ledger = new PostgresAiLedger(deps.database, config?.budget ?? { dailyProjectCallLimit: 40 });
  const maxOutputTokens = Math.min(config?.maxTokens ?? 1500, 1500);
  const model = config ? createBudgetedModel({ model: createDshJsonModel(config), ledger,
    maxInputBytes: config.maxInputBytes, maxOutputTokens, maxAttempts: 1, clock: () => deps.clock.now() }) : null;
  return createNavigatorService({ database: deps.database, projects: deps.projects, clock: deps.clock, ids: deps.ids,
    model, ledger, timeoutMs: config?.timeoutMs, maxOutputTokens, sessions: deps.sessions, siteSources: deps.siteSources });
}

export function createDshPersonalWorkspace(deps: { config: ApplicationConfig; database: DatabasePort; clock: Clock; ids: IdGenerator }) {
  const config = deps.config.dsh, ledger = new PostgresAiLedger(deps.database, config?.budget ?? { dailyProjectCallLimit: 40 });
  const maxOutputTokens = Math.min(config?.maxTokens ?? 4096, 8192);
  const model = config ? createBudgetedModel({ model: createDshJsonModel(config), ledger, maxInputBytes: config.maxInputBytes, maxOutputTokens, maxAttempts: 1, clock: () => deps.clock.now() }) : null;
  return createPersonalWorkspace({ ...deps, model, ledger, maxOutputTokens, timeoutMs: config?.timeoutMs });
}
