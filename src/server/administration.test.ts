import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "./database.ts";
import { grantVerifiedRole } from "./administration.ts";

test("trusted CLI role grant requires an existing verified active identity and commits an idempotent audit", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate();
    await assert.rejects(grantVerifiedRole(database, "unknown@example.test", "admin"));
    await assert.rejects(grantVerifiedRole(database, "unknown@example.test", "owner"));
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,platform_roles,email_verified_at,created_at) VALUES('operator','operator@example.test','operator','UTC',ARRAY['user'],now(),now())");
    assert.equal((await grantVerifiedRole(database, "operator@example.test", "reviewer")).changed, true);
    assert.equal((await grantVerifiedRole(database, "operator@example.test", "reviewer")).changed, false);
    assert.deepEqual((await database.query<{ platform_roles: string[] }>("SELECT platform_roles FROM auth_users WHERE id='operator'")).rows[0]?.platform_roles, ["reviewer", "user"]);
    assert.equal((await database.query("SELECT id FROM server_role_assignment_audit")).rowCount, 1);
    await database.query("UPDATE auth_users SET status='suspended' WHERE id='operator'");
    await assert.rejects(grantVerifiedRole(database, "operator@example.test", "admin"));
    assert.equal((await database.query("SELECT id FROM server_role_assignment_audit")).rowCount, 1);
  } finally { await database.close(); }
});
