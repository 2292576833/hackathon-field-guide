import { DomainError } from "../../shared/errors.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { MemberIntention, ProjectCollaborationRepository, ProjectTrackSelection } from "./collaboration.ts";

function conflict(): never { throw new DomainError("VERSION_CONFLICT", "资料已被更新，请查看最新版本后重试。", { status: 409, recoveryAction: "review_latest_version" }); }

/** Same transaction as ProjectsRepository.withProject: no private M03/M04/M05 writes. */
export class PostgresProjectCollaborationRepository implements ProjectCollaborationRepository {
  async getIntention(executor: SqlExecutor, projectId: string, userId: string): Promise<MemberIntention | null> {
    const result = await executor.query<{ body: MemberIntention }>("SELECT body FROM projects_member_intention WHERE project_id = $1 AND user_id = $2", [projectId, userId]);
    return result.rows[0]?.body ?? null;
  }
  async listIntentions(executor: SqlExecutor, projectId: string): Promise<MemberIntention[]> {
    const result = await executor.query<{ body: MemberIntention }>("SELECT body FROM projects_member_intention WHERE project_id = $1 ORDER BY user_id", [projectId]);
    return result.rows.map(row => row.body);
  }
  async saveIntention(executor: SqlExecutor, value: MemberIntention, expectedRevision: number): Promise<void> {
    if (value.revision !== expectedRevision + 1) throw new DomainError("INVALID_REVISION", "意愿版本必须递增一次。");
    const params = [value.projectId, value.userId, value.revision, JSON.stringify(value), expectedRevision];
    const result = expectedRevision === 0
      ? await executor.query("INSERT INTO projects_member_intention (project_id, user_id, revision, body) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING", params.slice(0, 4))
      : await executor.query("UPDATE projects_member_intention SET revision = $3, body = $4::jsonb WHERE project_id = $1 AND user_id = $2 AND revision = $5", params);
    if (result.rowCount !== 1) conflict();
    await executor.query("INSERT INTO projects_member_intention_history (project_id, user_id, revision, body) VALUES ($1, $2, $3, $4::jsonb)", params.slice(0, 4));
  }
  async getSelection(executor: SqlExecutor, projectId: string): Promise<ProjectTrackSelection | null> {
    const result = await executor.query<{ body: ProjectTrackSelection }>("SELECT body FROM projects_track_selection WHERE project_id = $1", [projectId]);
    return result.rows[0]?.body ?? null;
  }
  async listSelectionHistory(executor: SqlExecutor, projectId: string): Promise<ProjectTrackSelection[]> {
    const result = await executor.query<{ body: ProjectTrackSelection }>("SELECT body FROM projects_track_selection_history WHERE project_id = $1 ORDER BY revision DESC", [projectId]);
    return result.rows.map(row => row.body);
  }
  async saveSelection(executor: SqlExecutor, value: ProjectTrackSelection, expectedRevision: number): Promise<void> {
    if (value.revision !== expectedRevision + 1) throw new DomainError("INVALID_REVISION", "赛道选择版本必须递增一次。");
    const params = [value.projectId, value.revision, JSON.stringify(value), expectedRevision];
    const result = expectedRevision === 0
      ? await executor.query("INSERT INTO projects_track_selection (project_id, revision, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING", params.slice(0, 3))
      : await executor.query("UPDATE projects_track_selection SET revision = $2, body = $3::jsonb WHERE project_id = $1 AND revision = $4", params);
    if (result.rowCount !== 1) conflict();
    await executor.query("INSERT INTO projects_track_selection_history (project_id, revision, body) VALUES ($1, $2, $3::jsonb)", params.slice(0, 3));
  }
}
