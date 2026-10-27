import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/server/config.ts";
import { createApplication, type Application } from "../src/server/application.ts";
import { RESOURCE_CATALOG, createResourceCatalogCli, createResourceCatalogCheckpointPort } from "../src/modules/resources/index.ts";
import { normalizeLoginEmail } from "../src/modules/auth/index.ts";
import type { Actor, PlatformRole } from "../src/shared/contracts.ts";
import { DomainError } from "../src/shared/errors.ts";

const args = process.argv.slice(2); let app: Application | null = null;
try {
  if (args.includes("--import")) app = await createApplication(await loadConfig());
  async function trustedActor(lock = false): Promise<Actor> {
    if (!app || !process.env.RESOURCE_OPERATOR_EMAIL) throw new DomainError("AUTHENTICATION_REQUIRED", "请设置已验证运营账号的 RESOURCE_OPERATOR_EMAIL。", { status: 401 });
    const result = await app.database.query<{ id: string; platform_roles: PlatformRole[] }>(`SELECT id,platform_roles FROM auth_users WHERE email=$1 AND status='active' AND email_verified_at IS NOT NULL${lock ? " FOR SHARE" : ""}`, [normalizeLoginEmail(process.env.RESOURCE_OPERATOR_EMAIL)]);
    const user = result.rows[0];
    if (!user || !user.platform_roles.some(role => role === "admin" || role === "reviewer")) throw new DomainError("FORBIDDEN", "需要当前有效的真实运营或审核权限。", { status: 403 });
    return { userId: user.id, platformRoles: user.platform_roles };
  }
  const cli = createResourceCatalogCli({ entries: RESOURCE_CATALOG, clock: { now: () => new Date() }, requestIds: { next: () => randomUUID() }, loadTrustedActor: trustedActor,
    runEach: async work => {
      if (!app) throw new DomainError("CATALOG_DRY_RUN", "预览不写数据库。");
      return app.database.transaction(async tx => {
        await trustedActor(true);
        return work({ resources: app!.resources, reviews: app!.operations.services.resourceReview, checkpoints: createResourceCatalogCheckpointPort(tx) });
      });
    } });
  process.stdout.write(`${JSON.stringify(await cli.run(args), null, 2)}\n`);
} catch (error) { process.stderr.write(`${error instanceof DomainError ? error.code : "RESOURCE_CATALOG_FAILED"}\n`); process.exitCode = 1; }
finally { await app?.database.close(); }
