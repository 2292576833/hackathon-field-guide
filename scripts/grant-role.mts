import { loadConfig } from "../src/server/config.ts";
import { createDatabase } from "../src/server/database.ts";
import { grantVerifiedRole } from "../src/server/administration.ts";

const args = process.argv.slice(2);
if (args.length !== 2) throw new Error("Usage: npm run admin:grant -- verified-email@example.com admin|reviewer. Stop the local server before opening its embedded database.");
const config = await loadConfig();
const database = await createDatabase({ connectionString: config.databaseUrl, localPath: config.localDatabasePath });
try {
  await database.migrate();
  const result = await grantVerifiedRole(database, args[0]!, args[1]!);
  console.log(result.changed ? "Operations role assigned; the change was audited." : "Account already has this operations role.");
} finally { await database.close(); }
