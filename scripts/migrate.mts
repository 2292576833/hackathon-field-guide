import { createDatabase } from "../src/server/database.ts";
import { loadConfig } from "../src/server/config.ts";
const config = await loadConfig();
const db = await createDatabase({ connectionString: config.databaseUrl, localPath: config.localDatabasePath });
try { await db.migrate(); console.log(`Migrations applied: ${db.mode}.`); }
finally { await db.close(); }
