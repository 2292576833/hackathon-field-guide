import type { Project, ProjectMember, ProjectOfficialTracksView } from "../projects/index.ts";
import type { CurrentPlanningView } from "../planning/index.ts";
import type { EventRuleVersion, ProjectRuleConfirmation } from "../events/index.ts";
import type { getDeliverySummary, DeliveryVerification, GitOperation, SubmissionRecord } from "../github/index.ts";

/** Read-only projections. The owning modules remain the source of every fact. */
export interface SpaceDetail {
  project: Project;
  membership: ProjectMember;
  members: (ProjectMember & { displayName?: string | null })[];
}
export type SpacePhase = "formation" | "preparation" | "competition" | "presentation" | "reflection";
export interface SpaceLink { title: string; href: string; purpose: string }
export interface PhaseGuide {
  id: SpacePhase;
  title: string;
  purpose: string;
  actions: readonly SpaceLink[];
  tools: readonly SpaceLink[];
  caution: string;
}
export type ReadState<T> = { status: "unread" | "loading" } | { status: "error"; message: string } | { status: "ready"; value: T };
export interface SpaceRules { confirmation: ProjectRuleConfirmation | null; rules: EventRuleVersion | null }
type ExistingDeliverySummary = Awaited<ReturnType<typeof getDeliverySummary>>;
/** Array indexing in the owning function's inferred type omits these real empty
 * cases. Keep its wire DTO while explicitly representing successful empty reads. */
export type SpaceDeliverySummary = Omit<ExistingDeliverySummary, "repository" | "runtime"> & {
  repository: Omit<ExistingDeliverySummary["repository"], "latestOperation" | "status"> & { latestOperation: GitOperation | null; status: GitOperation["status"] | "not_saved" };
  runtime: Omit<ExistingDeliverySummary["runtime"], "latestHistoricalVerification"> & { latestHistoricalVerification: DeliveryVerification | null };
};
export interface LifecycleInput {
  detail: SpaceDetail;
  current: CurrentPlanningView | null;
  planningLoading?: boolean;
  planningError?: unknown;
  rules?: ReadState<SpaceRules>;
  tracks?: ReadState<ProjectOfficialTracksView>;
}
export interface LifecycleView {
  initialPhase: SpacePhase;
  readonly: boolean;
  solo: boolean;
  goal: string;
  minimumDeliverable: string;
  planningStatus: "unread" | "loading" | "error" | "empty" | "changed" | "current";
  planningNotice: string;
  next: SpaceLink;
  relatedTasks: { id: string; title: string; status: string; href: string }[];
  deadline: { instant: string; label: string; basis: string; fromSnapshot: boolean } | null;
}
export interface SubmissionStageView {
  id: string;
  title: string;
  officialUrl: string | null;
  deadline: EventRuleVersion["stages"][number]["endsAt"];
  requirements: { id: string; title: string; necessity: "required" | "optional" | "unknown" }[];
  records: SubmissionRecord[];
}
export interface SubmissionView {
  rulesStatus: ReadState<SpaceRules>["status"] | "empty" | "mismatch";
  rulesNotice: string;
  rulesVersion: string | null;
  stages: SubmissionStageView[];
  generalRequirements: SubmissionStageView["requirements"];
  deliveryStatus: ReadState<SpaceDeliverySummary>["status"];
  deliveryNotice: string;
  repositoryNotice: string;
  savedCommit: string | null;
  runtimeNotice: string;
  historicalRuntimeCount: number;
  history: SubmissionRecord[];
  unclassifiedRecords: SubmissionRecord[];
}
