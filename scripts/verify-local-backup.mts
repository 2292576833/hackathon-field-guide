import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, type ApplicationDatabase } from "../src/server/database.ts";
import type { SqlExecutor } from "../src/shared/persistence.ts";

// The default remains fixed. The only CLI input is a strict single-layer backup
// NAME under .runtime/backups, never a path, environment config or live connection.
// No createApplication, seed or migrate. Opening PGlite can write control files,
// so the explicitly named backup is read/copied, never opened as a database.
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(workspace, ".runtime");
const backups = resolve(runtime, "backups");
let backupName = "task-mission-20261010-000105";
let backup = resolve(backups, backupName);
const live = resolve(runtime, "postgres-data");
const clone = resolve(runtime, `restore-check-${randomUUID()}`);
let stage = "arguments", database: ApplicationDatabase | null = null;

const norm = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
function inside(child: string, parent: string): boolean {
  const rest = relative(norm(parent), norm(child));
  return Boolean(rest) && !isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`);
}
function ensure(condition: unknown): asserts condition { if (!condition) throw new Error("RESTORE_CHECK_FAILED"); }
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const tableName = (name: string) => `${quote("public")}.${quote(name)}`;
const count = (value: unknown) => {
  const parsed = Number(value); ensure(Number.isSafeInteger(parsed) && parsed >= 0); return parsed;
};

/** Hashes stay in memory and are never printed or saved to a report. */
async function manifest(root: string): Promise<{ fingerprint: string; files: number }> {
  const hash = createHash("sha256"); let files = 0;
  async function visit(folder: string) {
    for (const name of (await readdir(folder)).sort()) {
      const path = resolve(folder, name), entry = await lstat(path);
      ensure(inside(path, root) && !entry.isSymbolicLink());
      // A database snapshot must not smuggle unrelated configuration/keys into
      // its clone. No shell expansion or user-supplied names are executed.
      ensure(!/^(?:\.env(?:\..*)?|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|credentials\.json)$/i.test(name));
      ensure(!/\.(?:pem|key|p12|pfx)$/i.test(name));
      hash.update(relative(root, path).split(sep).join("/"));
      if (entry.isDirectory()) { hash.update("directory"); await visit(path); }
      else { ensure(entry.isFile()); files++; hash.update(await readFile(path)); }
    }
  }
  await visit(root); return { fingerprint: hash.digest("hex"), files };
}

interface TableSnapshot { table: string; rows: number; fingerprint: string }
interface Snapshot {
  migrationCount: number; lastMigrationId: string | null; tables: TableSnapshot[];
  foreignKeys: number; foreignKeyViolations: number; checks: number; checkViolations: number;
  jsonColumns: number; jsonValues: number; jsonParsed: number;
  tasks: number; plans: number; progressUpdates: number; planningScopeViolations: number;
  unknownJobs: number; uncertainUsageAttempts: number;
}

async function snapshot(db: ApplicationDatabase): Promise<Snapshot> {
  return db.transaction(async sql => {
    // Catalog/aggregate inspection cannot create application data or repair
    // constraints silently. Internal table digests prove content, not just count.
    await sql.query("SET TRANSACTION READ ONLY");
    const tables = (await sql.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(row => row.table_name);
    const required = ["application_migrations", "auth_users", "auth_sessions", "projects_project", "projects_project_membership", "m03_events", "m03_rule_versions", "m03_project_rules", "planning_states", "github_repository_bindings", "m06_delivery_verifications", "m06_submission_versions", "operations_event_reviews", "operations_resource_reviews", "ai_execution_jobs", "ai_budget_buckets", "ai_usage_attempts"];
    ensure(required.every(name => tables.includes(name)));
    const migration = (await sql.query<{ total: string; last_id: string | null }>("SELECT count(*)::text AS total,max(id) AS last_id FROM application_migrations")).rows[0];
    ensure(migration && Number(migration.total) > 0 && typeof migration.last_id === "string" && /^\d+[a-zA-Z0-9_\-]*\.sql$/.test(migration.last_id));
    const result: Snapshot = { migrationCount: count(migration.total), lastMigrationId: migration.last_id, tables: [], foreignKeys: 0, foreignKeyViolations: 0, checks: 0, checkViolations: 0, jsonColumns: 0, jsonValues: 0, jsonParsed: 0, tasks: 0, plans: 0, progressUpdates: 0, planningScopeViolations: 0, unknownJobs: 0, uncertainUsageAttempts: 0 };
    for (const table of tables) {
      // The fingerprint is a private in-memory comparison only. Sorting full
      // JSON values makes the comparison independent of physical row ordering.
      const row = (await sql.query<{ total: string; fingerprint: string }>(`SELECT count(*)::text AS total,md5(COALESCE(string_agg(row_json,E'\\n' ORDER BY row_json),'')) AS fingerprint FROM (SELECT to_jsonb(t)::text AS row_json FROM ${tableName(table)} t) rows`)).rows[0];
      ensure(row && /^[a-f0-9]{32}$/.test(row.fingerprint));
      result.tables.push({ table, rows: count(row.total), fingerprint: row.fingerprint });
    }
    const fks = (await sql.query<{ child_table: string; parent_table: string; parent_schema: string; match_type: string; child_columns: string[]; parent_columns: string[] }>(`
      SELECT child.relname AS child_table,parent.relname AS parent_table,pn.nspname AS parent_schema,c.confmatchtype AS match_type,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS child_columns,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS parent_columns
      FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
      JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
      WHERE c.contype='f' AND cn.nspname='public' ORDER BY child.relname,c.conname`)).rows;
    for (const fk of fks) {
      ensure(fk.parent_schema === "public" && ["s", "f"].includes(fk.match_type) && fk.child_columns.length > 0 && fk.child_columns.length === fk.parent_columns.length);
      const notNull = fk.child_columns.map(name => `child.${quote(name)} IS NOT NULL`).join(" AND ");
      const anyNotNull = fk.child_columns.map(name => `child.${quote(name)} IS NOT NULL`).join(" OR ");
      const someNull = fk.child_columns.map(name => `child.${quote(name)} IS NULL`).join(" OR ");
      const matches = fk.child_columns.map((name, i) => `child.${quote(name)}=parent.${quote(fk.parent_columns[i])}`).join(" AND ");
      const missing = `(${notNull}) AND NOT EXISTS(SELECT 1 FROM ${tableName(fk.parent_table)} parent WHERE ${matches})`;
      const invalid = fk.match_type === "f" ? `((${anyNotNull}) AND (${someNull})) OR (${missing})` : missing;
      result.foreignKeyViolations += await violations(sql, `SELECT count(*)::text AS total FROM ${tableName(fk.child_table)} child WHERE ${invalid}`); result.foreignKeys++;
    }
    const checks = (await sql.query<{ table_name: string; expression: string }>("SELECT t.relname AS table_name,pg_get_expr(c.conbin,c.conrelid) AS expression FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='c' AND n.nspname='public' ORDER BY t.relname,c.conname")).rows;
    for (const check of checks) {
      // SQL CHECK permits NULL; IS FALSE preserves that exact schema semantics.
      result.checkViolations += await violations(sql, `SELECT count(*)::text AS total FROM ${tableName(check.table_name)} WHERE (${check.expression}) IS FALSE`); result.checks++;
    }
    const json = (await sql.query<{ table_name: string; column_name: string }>("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND data_type IN ('json','jsonb') ORDER BY table_name,ordinal_position")).rows;
    for (const column of json) {
      const name = quote(column.column_name);
      const row = (await sql.query<{ values: string; parsed: string }>(`SELECT count(${name})::text AS values,count((${name}::text)::jsonb)::text AS parsed FROM ${tableName(column.table_name)}`)).rows[0];
      ensure(row); result.jsonColumns++; result.jsonValues += count(row.values); result.jsonParsed += count(row.parsed);
    }
    const planning = (await sql.query<{ tasks: string; plans: string; progress: string }>("SELECT COALESCE(sum(jsonb_array_length(state_json->'tasks')),0)::text AS tasks,COALESCE(sum(jsonb_array_length(state_json->'plans')),0)::text AS plans,COALESCE(sum(jsonb_array_length(state_json->'progressUpdates')),0)::text AS progress FROM planning_states")).rows[0];
    ensure(planning); result.tasks = count(planning.tasks); result.plans = count(planning.plans); result.progressUpdates = count(planning.progress);
    for (const field of ["tasks", "plans", "progressUpdates"]) {
      result.planningScopeViolations += await violations(sql, `SELECT count(*)::text AS total FROM planning_states s CROSS JOIN LATERAL jsonb_array_elements(s.state_json->'${field}') entry WHERE jsonb_typeof(entry)<>'object' OR entry->>'projectId' IS DISTINCT FROM s.project_id`);
    }
    result.unknownJobs = await violations(sql, "SELECT count(*)::text AS total FROM ai_execution_jobs WHERE status='unknown' OR external_state='unknown'");
    result.uncertainUsageAttempts = await violations(sql, "SELECT count(*)::text AS total FROM ai_usage_attempts WHERE status='reserved' OR external_state='unknown'");
    ensure(result.foreignKeys > 0 && result.checks > 0 && result.jsonColumns > 0);
    ensure(result.foreignKeyViolations === 0 && result.checkViolations === 0 && result.jsonValues === result.jsonParsed && result.planningScopeViolations === 0);
    return result;
  });
}
async function violations(sql: SqlExecutor, statement: string): Promise<number> {
  const row = (await sql.query<{ total: string }>(statement)).rows[0]; ensure(row); return count(row.total);
}

try {
  const argumentsList = process.argv.slice(2);
  ensure(argumentsList.length === 0 || argumentsList.length === 2 && argumentsList[0] === "--backup-name");
  if (argumentsList.length === 2) {
    ensure(typeof argumentsList[1] === "string" && argumentsList[1].length <= 200 && /^[a-z0-9-]+$/.test(argumentsList[1]));
    backupName = argumentsList[1];
    backup = resolve(backups, backupName);
  }
  stage = "paths";
  ensure(isAbsolute(backup) && inside(backup, backups) && norm(dirname(backup)) === norm(backups));
  ensure(norm(backup) !== norm(live) && !inside(backup, live) && !inside(live, backup));
  ensure(isAbsolute(clone) && inside(clone, runtime) && !inside(clone, live) && norm(clone) !== norm(live) && !inside(clone, backups) && norm(clone) !== norm(backup));
  // realpath checks the entire ancestor chain; lstat explicitly rejects links at
  // each allowed root. Descendant links are rejected by both source/clone manifests.
  for (const path of [runtime, backups, backup]) {
    const metadata = await lstat(path);
    ensure(metadata.isDirectory() && !metadata.isSymbolicLink() && norm(await realpath(path)) === norm(path));
  }
  let exists = true; try { await lstat(clone); } catch (error) { ensure((error as NodeJS.ErrnoException).code === "ENOENT"); exists = false; } ensure(!exists);
  const pgVersion = (await readFile(join(backup, "PG_VERSION"), "utf8")).trim(); ensure(/^\d{1,3}$/.test(pgVersion));
  stage = "source_manifest"; const original = await manifest(backup);
  // cp creates the previously verified non-existent destination itself. Avoid
  // optional timestamp mutation on copied Windows files; content is verified.
  stage = "copy_files"; await cp(backup, clone, { recursive: true, force: false, errorOnExist: true });
  ensure(norm(await realpath(clone)) === norm(clone));
  stage = "copied_manifest"; const copied = await manifest(clone); ensure(copied.fingerprint === original.fingerprint && copied.files === original.files);
  stage = "first_open"; database = await createDatabase({ localPath: clone }); ensure(database.mode === "local");
  stage = "first_read"; const first = await snapshot(database);
  stage = "first_close"; await database.close(); database = null;
  stage = "reopen"; database = await createDatabase({ localPath: clone });
  stage = "second_read"; const second = await snapshot(database);
  const stable = JSON.stringify(first) === JSON.stringify(second); ensure(stable);
  stage = "second_close"; await database.close(); database = null;
  stage = "backup_unchanged"; const retained = await manifest(backup); ensure(retained.fingerprint === original.fingerprint && retained.files === original.files);
  // Safe schema metadata and aggregates only; no row payload, email, token,
  // request ID, internal fingerprint, SQL expression or provider secret output.
  console.log(JSON.stringify({ passed: true, backupName, clonePath: clone, cloneWithinRuntime: true, backupUnchanged: true, migrationCount: first.migrationCount, lastMigrationId: first.lastMigrationId, postgresMajor: Number(pgVersion), tables: first.tables.map(({ table, rows }) => ({ table, rows })), foreignKeyChecks: first.foreignKeys, foreignKeyViolations: first.foreignKeyViolations, schemaChecks: first.checks, schemaViolations: first.checkViolations, jsonColumns: first.jsonColumns, jsonValues: first.jsonValues, jsonParsePassed: first.jsonValues === first.jsonParsed, planningTasks: first.tasks, planningPlans: first.plans, planningProgressUpdates: first.progressUpdates, planningScopeViolations: first.planningScopeViolations, unknownJobs: first.unknownJobs, uncertainUsageAttempts: first.uncertainUsageAttempts, reopenedContentEqual: stable, noMigrationApplied: true, noApplicationInitialized: true }));
} catch {
  console.log(JSON.stringify({ passed: false, stage })); process.exitCode = 1;
} finally {
  if (database) { try { await database.close(); } catch { console.log(JSON.stringify({ closePassed: false })); process.exitCode = 1; } }
}
