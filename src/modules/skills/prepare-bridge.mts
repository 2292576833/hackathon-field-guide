// Builds a standalone zero-dependency Node 24 distribution; does not install skills.
import ts from "typescript";
import { readFile, writeFile } from "node:fs/promises";
function transpile(source: string): string { return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText; }
const domain = transpile(await readFile(new URL("domain.ts", import.meta.url), "utf8")).replace(/^import .*shared\/errors\.ts.*\n/m, "").replaceAll("export ", "");
const adapters = transpile(await readFile(new URL("adapters.ts", import.meta.url), "utf8")).replaceAll("export ", "");
const network = transpile(await readFile(new URL("network.ts", import.meta.url), "utf8")).replaceAll("export ", "");
const bridge = transpile(await readFile(new URL("bridge.ts", import.meta.url), "utf8")).replace(/^import .*\.\/(?:adapters|domain|network)\.ts.*\n/gm, "").replace("import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual }", "import { createHmac, randomBytes, randomUUID, timingSafeEqual }").replaceAll("export ", "");
const cli = transpile(await readFile(new URL("../../../scripts/skills-bridge.mts", import.meta.url), "utf8")).replace(/^import .*bridge\.ts.*\n/m, "").replace('import { readFile } from "node:fs/promises";\n', "");
const source = `// Hackathon Skills Bridge v1; generated from audited source. Node 24+, no dependencies.\nclass DomainError extends Error { constructor(code, message) { super(message); this.code=code; } }\n${domain}\n${adapters}\n${network}\n${bridge}\n${cli}`;
await writeFile(new URL("standalone.ts", import.meta.url), `// Generated downloadable distribution; run prepare-bridge.mts after source changes.\nexport const STANDALONE_BRIDGE_SOURCE = ${JSON.stringify(source)};\n`);
process.stdout.write(`Standalone bridge: ${Buffer.byteLength(source)} bytes\n`);
