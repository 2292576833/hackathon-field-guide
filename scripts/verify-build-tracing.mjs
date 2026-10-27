import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const emptyReport = () => ({ manifestCount: 0, changedManifestCount: 0, filteredReferences: 0, remainingPrivateReferences: 0, copiedPrivateEntries: 0 });
const privateSegment = segment => {
  const name = segment.toLowerCase();
  return name === ".private" || name === ".env" || name.startsWith(".env.") || name === "credentials.yaml" || name === ".credentials.yaml" || name === "local-secrets.json";
};
const segments = value => value.split(/[\\/]+/).filter(Boolean);
const within = (parent, target, allowSame = true) => {
  const part = relative(parent, target);
  return (allowSame || part !== "") && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};

/** Reports contain counts only: private paths and file contents never enter diagnostics. */
export class BuildTracingError extends Error {
  constructor(code, report = emptyReport()) {
    super(code);
    this.name = "BuildTracingError";
    this.code = code;
    this.report = { ...report };
  }
}

/** Inspect only build output and its NFT manifests. Source secrets are never read.
 * Sanitization removes packaging references; already-copied secrets fail closed.
 * No workspace file or output copy is deleted by this utility. */
export async function verifyBuildTracing({ projectRoot = process.cwd(), buildDirectory = ".next", sanitize = false } = {}) {
  const report = emptyReport();
  let root, output;
  try {
    if (typeof projectRoot !== "string" || typeof buildDirectory !== "string" || !projectRoot || !buildDirectory) throw new BuildTracingError("BUILD_DIRECTORY_INVALID");
    const requestedRoot = resolve(projectRoot);
    const requestedOutput = resolve(requestedRoot, buildDirectory);
    if (!within(requestedRoot, requestedOutput, false)) throw new BuildTracingError("BUILD_DIRECTORY_OUTSIDE_PROJECT");
    root = await realpath(requestedRoot);
    const outputEntry = await lstat(requestedOutput);
    if (!outputEntry.isDirectory() || outputEntry.isSymbolicLink()) throw new BuildTracingError("BUILD_DIRECTORY_INVALID");
    output = await realpath(requestedOutput);
    if (!within(root, output, false)) throw new BuildTracingError("BUILD_DIRECTORY_OUTSIDE_PROJECT");
  } catch (error) {
    if (error instanceof BuildTracingError) throw error;
    throw new BuildTracingError("BUILD_DIRECTORY_UNAVAILABLE");
  }

  const manifests = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = resolve(directory, entry.name);
      const parts = segments(relative(output, file));
      if (parts.some(part => privateSegment(part) || part.toLowerCase() === ".runtime")) {
        report.copiedPrivateEntries++;
        // Never inspect the contents of a private output file or directory.
        continue;
      }
      // Symlinks are not traversed or read, including links outside the project.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /(?:^|\.)nft\.json$/i.test(entry.name)) manifests.push(file);
    }
  }

  const changes = [];
  try {
    await visit(output);
    for (const file of manifests) {
      report.manifestCount++;
      const manifest = JSON.parse(await readFile(file, "utf8"));
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Array.isArray(manifest.files) || manifest.files.some(item => typeof item !== "string" || item.includes("\0"))) throw new BuildTracingError("BUILD_TRACING_MANIFEST_INVALID", report);
      const files = manifest.files.filter(reference => {
        const target = resolve(dirname(file), reference.replace(/[\\/]/g, sep));
        const secret = within(resolve(root, ".runtime"), target) || segments(reference).some(privateSegment) || segments(target).some(privateSegment);
        if (secret) report.remainingPrivateReferences++;
        return !secret;
      });
      if (files.length !== manifest.files.length) changes.push({ file, manifest: { ...manifest, files }, removed: manifest.files.length - files.length });
    }
    if (report.copiedPrivateEntries > 0) throw new BuildTracingError("BUILD_OUTPUT_CONTAINS_PRIVATE_FILES", report);
    if (report.remainingPrivateReferences > 0 && !sanitize) throw new BuildTracingError("BUILD_TRACING_CONTAINS_PRIVATE_REFERENCES", report);
    if (sanitize) {
      for (const change of changes) {
        // Revalidate the destination immediately before changing a manifest.
        const entry = await lstat(change.file);
        const destination = await realpath(change.file);
        if (!entry.isFile() || entry.isSymbolicLink() || !within(output, destination, false)) throw new BuildTracingError("BUILD_TRACING_DESTINATION_INVALID", report);
        await writeFile(change.file, `${JSON.stringify(change.manifest, null, 2)}\n`, "utf8");
        report.changedManifestCount++;
        report.filteredReferences += change.removed;
        report.remainingPrivateReferences -= change.removed;
      }
    }
    return { ...report };
  } catch (error) {
    if (error instanceof BuildTracingError) throw error;
    // Parser and filesystem errors can contain file names or excerpts. Do not
    // propagate those details into postbuild output or the public error object.
    throw new BuildTracingError("BUILD_TRACING_INSPECTION_FAILED", report);
  }
}

export async function runBuildTracingCli(args = process.argv.slice(2), { projectRoot = process.cwd(), write = text => { process.stdout.write(text); } } = {}) {
  try {
    if (args.some(argument => argument !== "--sanitize") || new Set(args).size !== args.length) throw new BuildTracingError("BUILD_TRACING_ARGUMENT_INVALID");
    const report = await verifyBuildTracing({ projectRoot, sanitize: args.includes("--sanitize") });
    write(`${JSON.stringify({ ...report, failures: 0 })}\n`);
    return 0;
  } catch (error) {
    const report = error instanceof BuildTracingError ? error.report : emptyReport();
    write(`${JSON.stringify({ ...report, failures: 1 })}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runBuildTracingCli();
