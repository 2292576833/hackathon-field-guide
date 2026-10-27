import type { DatabasePort } from "../shared/persistence.ts";
import type { Clock } from "../shared/contracts.ts";

/**
 * 机构级设置。第一条是白标开关（规划 39）：
 *   deploymentMode = "public"（默认）| "white_label"
 * 同一机构下**所有赛事**共享，不逐场配置。
 */
export const DEPLOYMENT_MODES = ["public", "white_label"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export function isDeploymentMode(value: unknown): value is DeploymentMode {
  return typeof value === "string" && (DEPLOYMENT_MODES as readonly string[]).includes(value);
}

/** 纯函数：从 settings 里读白标开关；缺失或非法一律按 public（不默认开启）。 */
export function deploymentModeOf(settings: unknown): DeploymentMode {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "public";
  const value = (settings as Record<string, unknown>).deploymentMode;
  return isDeploymentMode(value) ? value : "public";
}

export function createOrganizerSettingsService(deps: { database: DatabasePort; clock: Clock }) {
  async function read(organizationId: string): Promise<{ deploymentMode: DeploymentMode }> {
    const rows = await deps.database.query<{ settings: unknown }>("SELECT settings FROM organizer_settings WHERE organization_id=$1", [organizationId]);
    return { deploymentMode: deploymentModeOf(rows.rows[0]?.settings) };
  }

  /** 只允许两个值；写入是 upsert，settings 整体替换（目前只有一个键）。 */
  async function setDeploymentMode(organizationId: string, mode: unknown): Promise<{ deploymentMode: DeploymentMode }> {
    if (!isDeploymentMode(mode)) throw new Error("DEPLOYMENT_MODE_INVALID");
    await deps.database.query(
      "INSERT INTO organizer_settings(organization_id,settings,updated_at) VALUES($1,$2::jsonb,$3::timestamptz) ON CONFLICT (organization_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=EXCLUDED.updated_at",
      [organizationId, JSON.stringify({ deploymentMode: mode }), deps.clock.now().toISOString()],
    );
    return { deploymentMode: mode };
  }

  return { read, setDeploymentMode };
}
