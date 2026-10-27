/**
 * `space-resource` 公共导出。
 *
 * 只导出纯计算与纯类型：不导入 TSX、React、数据库、账号或任何赛事/报名存储。
 * 界面与根装配由主会话完成（见交付文档的 `NEEDS_ROOT`）。
 */

export {
  SPACE_PHASE_BASIS_LABELS,
  SPACE_PHASE_LABELS,
  type SpaceBudgetInput,
  type SpaceBudgetView,
  type SpaceDeadlineInput,
  type SpaceDeadlineKind,
  type SpaceDeadlineSkip,
  type SpaceDeadlineSkipReason,
  type SpaceDeadlineView,
  type SpaceNextDeadlineView,
  type SpacePhase,
  type SpacePhaseBasis,
  type SpaceResourceInput,
  type SpaceResourceInvalid,
  type SpaceResourceIssue,
  type SpaceResourceIssueReason,
  type SpaceResourceOutcome,
  type SpaceResourceResult,
  type SpaceResourceValid,
} from "./model.ts";

export {
  computePhase,
  computeSpaceResource,
  formatMicros,
  isValidUtcInstant,
  parseUtcInstant,
  phaseBasisLabel,
} from "./compute.ts";
