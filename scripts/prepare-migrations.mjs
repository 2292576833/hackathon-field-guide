import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Source proposals stay owned by their modules. The checked-in combined migration is owned by integration.
const proposals = [
  "auth/migrations/001_auth.sql", "projects/sql/001-projects.sql", "events/migrations/001-events.sql",
  "assessments/sql/001-assessments.sql", "planning/migrations/001-planning.sql",
  "github/sql/git.sql", "github/sql/delivery.sql", "retrospectives/migrations/001_retrospectives.sql",
  "resources/migrations/001-resources.sql", "operations/sql/source-runs.sql", "operations/sql/event-reviews.sql",
  "operations/sql/resource-reviews.sql", "operations/sql/corrections.sql",
];
const parts = [];
for (const proposal of proposals) {
  const source = await readFile(join(process.cwd(), "src/modules", proposal), "utf8");
  parts.push(`-- Module proposal: ${proposal}\n${source.replace(/^\s*(BEGIN|COMMIT);\s*$/gm, "").trim()}`);
}
await mkdir("migrations", { recursive: true });
// Never rewrite a checked-in/applied migration. Schema changes use new numbered files.
await writeFile("migrations/001_initial.sql", `-- Initial integrated schema. Do not regenerate after this migration is applied.\n\n${parts.join("\n\n")}\n`, { flag: "wx" });
console.log(`Prepared initial migration from ${proposals.length} module proposals.`);
