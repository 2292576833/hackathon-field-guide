import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const scope = process.argv[2];
if (scope && !/^[a-z][a-z-]*$/.test(scope)) {
  throw new Error("Module scope must be a directory slug.");
}
const directories = scope
  ? [join(root, "src/modules", scope)]
  : [join(root, "src/modules"), join(root, "src/shared")];

async function collect(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const groups = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  }));
  return groups.flat();
}

const tests = (await Promise.all(directories.map(collect))).flat().sort();
if (tests.length === 0) {
  process.stderr.write("No module tests have been delivered yet.\n");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--test", ...tests], {
    cwd: root, stdio: "inherit", shell: false,
  });
  child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}
