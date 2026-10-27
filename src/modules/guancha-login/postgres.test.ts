import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PostgresGuanchaAttemptStore, createNodeGuanchaCrypto } from "./index.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";

test("isolated PostgreSQL engine atomically consumes matching state once and erases secrets", async () => {
  const engine = new PGlite(); await engine.waitReady;
  const sql: SqlExecutor = { async query<Row>(statement: string, parameters: readonly unknown[] = []) {
    const result = await engine.query<Row>(statement, [...parameters]);
    return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
  } };
  try {
    await engine.exec("CREATE TABLE auth_users(id text PRIMARY KEY)");
    await engine.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
    const store = new PostgresGuanchaAttemptStore(sql);
    const crypto = createNodeGuanchaCrypto("test-only-pglite-guancha-encryption-key");
    const now = "2026-10-12T00:00:00.000Z", stateHash = crypto.hash("state"), browserBindingHash = crypto.hash("binding");
    const secretCiphertext = crypto.seal({ nonce: null, codeVerifier: crypto.randomToken() }, stateHash);
    const attempt = {
      stateHash, browserBindingHash, issuer: "https://provider.example.test", configurationId: "v1",
      redirectUri: "https://app.example.test/callback", returnTo: "/events", secretCiphertext,
      createdAt: now, expiresAt: "2026-10-12T00:10:00.000Z",
    };
    await store.save(attempt);
    const input = { stateHash, browserBindingHash, issuer: attempt.issuer, configurationId: "v1", redirectUri: attempt.redirectUri, now };
    assert.equal(await store.consume({ ...input, browserBindingHash: crypto.hash("wrong") }), null);
    assert.equal(await store.consume({ ...input, configurationId: "v2" }), null);
    assert.equal(await store.consume({ ...input, redirectUri: "https://app.example.test/wrong" }), null);
    assert.equal(await store.consume({ ...input, now: attempt.expiresAt }), null);
    const results = await Promise.all([store.consume(input), store.consume(input)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.find(Boolean), attempt);
    const row = (await engine.query<{ consumed_at: Date; secret_ciphertext: string | null }>("SELECT consumed_at,secret_ciphertext FROM guancha_login_attempts")).rows[0]!;
    assert.equal(new Date(row.consumed_at).toISOString(), now);
    assert.equal(row.secret_ciphertext, null);
    assert.equal(await store.consume(input), null);
    await assert.rejects(store.save(attempt));
    // Provider keys retain case and cannot be rebound to another local account.
    await engine.exec("INSERT INTO auth_users(id) VALUES('user-1'),('user-2')");
    await engine.query("INSERT INTO guancha_identity_bindings VALUES($1,$2,$3,$4)", [attempt.issuer, "SUBJECT", "user-1", now]);
    await assert.rejects(engine.query("INSERT INTO guancha_identity_bindings VALUES($1,$2,$3,$4)", [attempt.issuer, "SUBJECT", "user-2", now]));
    await engine.query("INSERT INTO guancha_identity_bindings VALUES($1,$2,$3,$4)", [attempt.issuer, "subject", "user-2", now]);
  } finally { await engine.close(); }
});
