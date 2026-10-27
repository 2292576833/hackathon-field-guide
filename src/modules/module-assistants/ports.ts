import type { Actor, Clock } from "../../shared/contracts.ts";
import type {
  ModuleAssistantFacts, ModuleAssistantFactsRequest, ModuleAssistantLedgerEntry, ModuleAssistantLedgerRecord,
  ModuleAssistantModelRequest, ModuleAssistantModelResult, ModuleAssistantScope,
} from "./model.ts";

/** 授权范围只读 Port。根适配既有 StaffGrant / HostedEventAccessPort，模块自己不查库。 */
export interface ModuleAssistantScopePort {
  resolve(input: { readonly actor: Actor; readonly eventId: string }): Promise<ModuleAssistantScope>;
}

/** 每模块一个只读方法，返回结构化既有事实。模块 MUST NOT 直接查库。 */
/** 只接入其中一部分键是允许的：没接的键调用时返回 503，而不是假装没有数据。 */
export type ModuleAssistantFactsPort = Partial<{
  readonly overview: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly registration: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly teams: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly communication: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly schedule: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly services: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly judging: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly enroll: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly teamup: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly submit: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly results: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly retro: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly plan: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
  readonly resources: (input: ModuleAssistantFactsRequest) => Promise<ModuleAssistantFacts>;
}>;

/** 注入的模型 Port。模块自己不接 DSH 网络调用；根适配既有 DSH 管道与预算。 */
export interface ModuleAssistantModelPort {
  readonly available: boolean;
  readonly modelVersion: string;
  complete(request: ModuleAssistantModelRequest): Promise<ModuleAssistantModelResult>;
}

/** 注入的账本 Port。每次调用都要记录谁、哪个模块、读了什么范围、花费。 */
export interface ModuleAssistantLedgerPort {
  record(entry: ModuleAssistantLedgerEntry): Promise<ModuleAssistantLedgerRecord>;
}

export interface ModuleAssistantPorts {
  readonly scope: ModuleAssistantScopePort;
  readonly facts: ModuleAssistantFactsPort;
  readonly model: ModuleAssistantModelPort;
  readonly ledger: ModuleAssistantLedgerPort;
}

export interface ModuleAssistantDependencies extends ModuleAssistantPorts {
  readonly clock: Clock;
}
