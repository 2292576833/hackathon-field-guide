import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";

interface TransactionContext { executor: SqlExecutor; executeBatch?: (sql: string) => Promise<unknown>; sequence: { value: number }; childActive: boolean }
export interface ApplicationDatabase extends DatabasePort {
  mode: "postgres" | "local";
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/** Ambient queries reuse the current transaction; cross-module ports never borrow a second connection. */
export async function createDatabase(options: { connectionString?: string; localPath?: string; maxConnections?: number }): Promise<ApplicationDatabase> {
  const context = new AsyncLocalStorage<TransactionContext>();
  const engine = options.connectionString ? new Pool({ connectionString: options.connectionString, max: options.maxConnections ?? 10 }) : new PGlite(options.localPath);
  if (engine instanceof PGlite) await engine.waitReady;
  function executor(query: (sql: string, parameters: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null; affectedRows?: number }>): SqlExecutor {
    return { async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      const result = await query(sql, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? (result.rows.length || result.affectedRows || 0) };
    } };
  }
  const direct = engine instanceof Pool
    ? executor(async (sql, parameters) => { const result = await engine.query(sql, parameters); return { rows: result.rows, rowCount: result.rowCount }; })
    : executor(async (sql, parameters) => { const result = await engine.query(sql, parameters); return { rows: result.rows, affectedRows: result.affectedRows }; });
  const database: ApplicationDatabase = {
    mode: engine instanceof Pool ? "postgres" : "local",
    async query<Row>(sql: string, parameters: readonly unknown[] = []) { return (context.getStore()?.executor ?? direct).query<Row>(sql, parameters); },
    async transaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
      const existing = context.getStore();
      if (existing) {
        if (existing.childActive) throw new Error("Parallel nested transactions are not supported.");
        existing.childActive = true;
        const name = `composition_${++existing.sequence.value}`;
        try {
          await existing.executor.query(`SAVEPOINT ${name}`);
          try {
            const result = await context.run({ executor: existing.executor, executeBatch: existing.executeBatch, sequence: existing.sequence, childActive: false }, () => work(existing.executor));
            await existing.executor.query(`RELEASE SAVEPOINT ${name}`);
            return result;
          } catch (error) {
            await existing.executor.query(`ROLLBACK TO SAVEPOINT ${name}`);
            await existing.executor.query(`RELEASE SAVEPOINT ${name}`);
            throw error;
          }
        } finally { existing.childActive = false; }
      }
      if (engine instanceof PGlite) {
        return engine.transaction(async transaction => {
          const sql = executor(async (statement, parameters) => { const result = await transaction.query(statement, parameters); return { rows: result.rows, affectedRows: result.affectedRows }; });
          return context.run({ executor: sql, executeBatch: statement => transaction.exec(statement), sequence: { value: 0 }, childActive: false }, () => work(sql));
        });
      }
      const client = await engine.connect();
      const sql = executor(async (statement, parameters) => { const result = await client.query(statement, parameters); return { rows: result.rows, rowCount: result.rowCount }; });
      try {
        await client.query("BEGIN");
        const result = await context.run({ executor: sql, executeBatch: statement => client.query(statement), sequence: { value: 0 }, childActive: false }, () => work(sql));
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async migrate() {
      await direct.query("CREATE TABLE IF NOT EXISTS application_migrations (id text PRIMARY KEY, content_hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const file of (await readdir(join(process.cwd(), "migrations"))).filter(file => /^\d+.*\.sql$/.test(file)).sort()) {
        const sql = await readFile(join(process.cwd(), "migrations", file), "utf8");
        const hash = createHash("sha256").update(sql).digest("hex");
        await database.transaction(async transaction => {
          await transaction.query("SELECT pg_advisory_xact_lock(78731429)");
          const applied = await transaction.query<{ content_hash: string }>("SELECT content_hash FROM application_migrations WHERE id=$1", [file]);
          if (applied.rows[0]) {
            if (applied.rows[0].content_hash !== hash) throw new Error(`Applied migration was modified: ${file}`);
            return;
          }
          // Migrations are trusted repository files; never user or model-supplied statements.
          // PostgreSQL returns an array of results for a multi-statement batch.
          // Execute trusted migration DDL on its owned connection, without the
          // single-statement row projection used by ordinary module queries.
          await context.getStore()!.executeBatch!(sql);
          await transaction.query("INSERT INTO application_migrations(id,content_hash) VALUES ($1,$2)", [file, hash]);
        });
      }
    },
    async close() { if (engine instanceof Pool) await engine.end(); else await engine.close(); },
  };
  return database;
}
