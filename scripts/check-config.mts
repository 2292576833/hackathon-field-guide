/** Read configuration names only. Never print credentials or provider response bodies. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
const mode = process.env.APP_MODE === "local" || (!process.env.APP_MODE && process.env.NODE_ENV !== "production") ? "local" : "connected";
let retainedLocalPepper = false;
let localDatabasePresent = false;
if (mode === "local") {
  try {
    const local = JSON.parse(await readFile(join(process.cwd(), ".runtime", "local-secrets.json"), "utf8")) as { codePepper?: unknown };
    retainedLocalPepper = typeof local.codePepper === "string" && Buffer.byteLength(local.codePepper) >= 32;
  } catch { /* A missing or invalid retained secret is reported by name only. */ }
  try { localDatabasePresent = (await stat(join(process.cwd(), ".runtime", "postgres-data"))).isDirectory(); } catch { /* No initialized local data yet. */ }
}
const dshCredentialName = process.env.DSH_DESKTOP_DIRECTORY ? "DSH_DESKTOP_DIRECTORY" : process.env.DSH_ACCOUNT_CREDENTIALS_FILE ? "DSH_ACCOUNT_CREDENTIALS_FILE" : "DSH_API_KEY";
const groups: Record<string, readonly string[]> = {
  website: ["AUTH_ORIGIN", "AUTH_CODE_PEPPER"],
  database: ["DATABASE_URL"],
  email: process.env.AUTH_EMAIL_PROVIDER === "smtp" || (!process.env.RESEND_API_KEY && process.env.SMTP_PASSWORD) ? ["SMTP_USER", "SMTP_PASSWORD"] : ["AUTH_EMAIL_FROM", "RESEND_API_KEY"],
  model: process.env.AI_PROVIDER === "dsh" || process.env.DSH_DESKTOP_DIRECTORY || process.env.DSH_ACCOUNT_CREDENTIALS_FILE ? ["DSH_MODEL", dshCredentialName, "DSH_INPUT_MICRO_USD_PER_MILLION", "DSH_OUTPUT_MICRO_USD_PER_MILLION"] : ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL"],
  github: ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_TOKEN_ENCRYPTION_KEY"],
  dsh: [dshCredentialName, "DSH_MODEL", "DSH_INPUT_MICRO_USD_PER_MILLION", "DSH_OUTPUT_MICRO_USD_PER_MILLION"],
  discovery: process.env.DISCOVERY_PROVIDER === "dsh_native" ? ["DISCOVERY_PROVIDER", dshCredentialName, "DSH_MODEL", "DSH_INPUT_MICRO_USD_PER_MILLION", "DSH_OUTPUT_MICRO_USD_PER_MILLION"] : process.env.DISCOVERY_PROVIDER === "official_sources" ? ["DISCOVERY_PROVIDER", "DSH_MODEL", dshCredentialName] : ["BRAVE_SEARCH_API_KEY", "BRAVE_SEARCH_COST_MICRO_USD_PER_CALL"],
};
const report = Object.fromEntries(Object.entries(groups).map(([group, names]) => [group, {
  configured: names.every(name => configured(name)),
  missing: names.filter(name => !configured(name)),
  ...(group === "database" ? { storage: process.env.DATABASE_URL ? "postgres" : mode === "local" ? "pglite" : "unconfigured" } : {}),
}]));
function configured(name: string) {
  if (process.env[name]?.trim()) return true;
  if (mode !== "local") return false;
  if (name === "AUTH_CODE_PEPPER") return retainedLocalPepper;
  if (name === "AUTH_ORIGIN") return true; // The local runtime has an explicit loopback default.
  if (name === "DATABASE_URL") return localDatabasePresent;
  return false;
}
process.stdout.write(`${JSON.stringify({ mode, groups: report }, null, 2)}\n`);
if (Object.values(report).some(group => !group.configured)) process.exitCode = 1;
