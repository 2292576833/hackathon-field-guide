import { randomUUID } from "node:crypto";
import type { DatabasePort } from "../shared/persistence.ts";
import { normalizeLoginEmail } from "../modules/auth/service.ts";

/** Trusted server CLI only; this function is never mounted as a public HTTP endpoint. */
export async function grantVerifiedRole(database: DatabasePort, email: string, role: string): Promise<{ changed: boolean }> {
  if (!["admin", "reviewer"].includes(role)) throw new Error("Role must be admin or reviewer.");
  email = normalizeLoginEmail(email);
  return database.transaction(async transaction => {
    const result = await transaction.query<{ id: string; platform_roles: string[] }>("SELECT id,platform_roles FROM auth_users WHERE email=$1 AND status='active' AND email_verified_at IS NOT NULL FOR UPDATE", [email]);
    const user = result.rows[0];
    if (!user) throw new Error("An active, email-verified account must exist before assigning an operations role.");
    if (user.platform_roles.includes(role)) return { changed: false };
    const roles = [...new Set([...user.platform_roles, role])].sort();
    await transaction.query("UPDATE auth_users SET platform_roles=$2::text[],revision=revision+1 WHERE id=$1", [user.id, roles]);
    await transaction.query("INSERT INTO server_role_assignment_audit(id,user_id,added_role,previous_roles,new_roles,authority) VALUES($1,$2,$3,$4::text[],$5::text[],'trusted_server_cli')", [randomUUID(), user.id, role, user.platform_roles, roles]);
    return { changed: true };
  });
}
