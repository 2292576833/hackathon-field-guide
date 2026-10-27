import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!["dev", "start"].includes(mode)) throw new Error("Serve mode must be dev or start.");
const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("next/dist/bin/next")), mode, "--hostname", "127.0.0.1", ...process.argv.slice(3)], {
  env: { ...process.env, FIELD_GUIDE_SERVE: "1" }, stdio: "inherit", shell: false, windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("error", () => { console.error("[backend] Unable to start web server."); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
