import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { BuildTracingError, runBuildTracingCli, verifyBuildTracing } from "../../scripts/verify-build-tracing.mjs";

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "field-guide-build-tracing-"));
  const buildDirectory = join(projectRoot, ".next");
  await mkdir(buildDirectory);
  const file = async (path: string, content: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); return path; };
  const manifest = async (path: string, files: string[]) => file(path, JSON.stringify({ version: 1, files, customField: { preserve: true } }));
  return { projectRoot, buildDirectory, file, manifest, close: () => rm(projectRoot, { recursive: true, force: true }) };
}
const codeIs = (code: string) => (error: unknown) => error instanceof BuildTracingError && error.code === code;

test("trace sanitizer removes private references at every manifest depth while preserving dependency references and metadata", async () => {
  const f = await fixture();
  try {
    const sourceSecret = await f.file(join(f.projectRoot, ".env.local"), "PRIVATE_SOURCE_SECRET_DO_NOT_READ");
    const runtimeSecret = await f.file(join(f.projectRoot, ".runtime", "opaque-store"), "PRIVATE_RUNTIME_SECRET_DO_NOT_READ");
    const locations = [join(f.buildDirectory, "next-server.js.nft.json"), join(f.buildDirectory, "server", "instrumentation.js.nft.json"), join(f.buildDirectory, "server", "app", "api", "v1", "route.js.nft.json")];
    for (const location of locations) {
      await f.manifest(location, [
        relative(dirname(location), join(f.projectRoot, "node_modules", "next", "package.json")),
        "./ordinary-public.js",
        relative(dirname(location), sourceSecret),
        relative(dirname(location), runtimeSecret),
        "../../account/.credentials.yaml",
        "../../account/credentials.yaml",
        "../../store/local-secrets.json",
        "../../nested/.env/config",
        "../../vendor/.env.js",
      ]);
    }
    const report = await verifyBuildTracing({ projectRoot: f.projectRoot, sanitize: true });
    assert.deepEqual(report, { manifestCount: 3, changedManifestCount: 3, filteredReferences: 21, remainingPrivateReferences: 0, copiedPrivateEntries: 0 });
    for (const location of locations) {
      const result = JSON.parse(await readFile(location, "utf8"));
      assert.equal(result.version, 1); assert.deepEqual(result.customField, { preserve: true });
      assert.equal(result.files.length, 2); assert.ok(result.files[0].endsWith("package.json")); assert.equal(result.files[1], "./ordinary-public.js");
    }
    // Source secrets remain intact: only the manifests in output were changed.
    assert.equal(await readFile(sourceSecret, "utf8"), "PRIVATE_SOURCE_SECRET_DO_NOT_READ");
    assert.equal(await readFile(runtimeSecret, "utf8"), "PRIVATE_RUNTIME_SECRET_DO_NOT_READ");
    const repeated = await verifyBuildTracing({ projectRoot: f.projectRoot, sanitize: true });
    assert.equal(repeated.changedManifestCount, 0); assert.equal(repeated.filteredReferences, 0);
  } finally { await f.close(); }
});

test("verify-only mode rejects private references without writing manifests or reading the source secret", async () => {
  const f = await fixture();
  try {
    // This non-existent private target must still be removed based only on its
    // reference. Inspecting source contents is neither required nor allowed.
    const manifest = await f.manifest(join(f.buildDirectory, "instrumentation.js.nft.json"), ["../.runtime/missing-sensitive-data", "../.env.production", "../node_modules/next/package.json"]);
    const before = await readFile(manifest, "utf8");
    await assert.rejects(verifyBuildTracing({ projectRoot: f.projectRoot }), codeIs("BUILD_TRACING_CONTAINS_PRIVATE_REFERENCES"));
    assert.equal(await readFile(manifest, "utf8"), before);
    const report = await verifyBuildTracing({ projectRoot: f.projectRoot, sanitize: true });
    assert.equal(report.filteredReferences, 2); assert.equal(report.remainingPrivateReferences, 0);
  } finally { await f.close(); }
});

test("sanitization fails closed for copied standalone secrets instead of hiding or deleting them", async () => {
  const f = await fixture();
  try {
    const copiedSecret = await f.file(join(f.buildDirectory, "standalone", ".env.local"), "PRIVATE_ALREADY_COPIED_VALUE");
    const manifest = await f.manifest(join(f.buildDirectory, "server", "instrumentation.js.nft.json"), ["../../.runtime/data", "../../node_modules/next/package.json"]);
    const before = await readFile(manifest, "utf8");
    await assert.rejects(verifyBuildTracing({ projectRoot: f.projectRoot, sanitize: true }), codeIs("BUILD_OUTPUT_CONTAINS_PRIVATE_FILES"));
    assert.equal(await readFile(manifest, "utf8"), before);
    assert.equal(await readFile(copiedSecret, "utf8"), "PRIVATE_ALREADY_COPIED_VALUE");
  } finally { await f.close(); }
});

test("private output directories and credential copies are detected without inspecting directory contents", async () => {
  for (const privateName of [".runtime", ".private", ".env", "credentials.yaml", ".credentials.yaml", "local-secrets.json"]) {
    const f = await fixture();
    try {
      if (privateName.startsWith(".runtime") || privateName === ".private" || privateName === ".env") await mkdir(join(f.buildDirectory, "standalone", privateName), { recursive: true });
      else await f.file(join(f.buildDirectory, "standalone", privateName), "PRIVATE_COPY");
      await assert.rejects(verifyBuildTracing({ projectRoot: f.projectRoot, sanitize: true }), error => error instanceof BuildTracingError && error.code === "BUILD_OUTPUT_CONTAINS_PRIVATE_FILES" && error.report.copiedPrivateEntries === 1);
    } finally { await f.close(); }
  }
});

test("clean output manifests retain their original bytes", async () => {
  const f = await fixture();
  try {
    const manifest = await f.file(join(f.buildDirectory, "server", "route.js.nft.json"), '{"version":1,"files":["../../node_modules/public/package.json"],"extra":23}');
    const before = await readFile(manifest, "utf8");
    const report = await verifyBuildTracing({ projectRoot: f.projectRoot, sanitize: true });
    assert.equal(report.changedManifestCount, 0); assert.equal(report.manifestCount, 1);
    assert.equal(await readFile(manifest, "utf8"), before);
  } finally { await f.close(); }
});

test("CLI output contains numeric counts only on success, private-reference rejection and malformed manifests", async () => {
  const f = await fixture();
  try {
    const manifest = await f.manifest(join(f.buildDirectory, "instrumentation.js.nft.json"), ["../.runtime/PRIVATE_PATH_SENTINEL", "../.env.PRIVATE_SECRET_SENTINEL"]);
    for (const args of [[], ["--sanitize"]]) {
      let output = "";
      const exitCode = await runBuildTracingCli(args, { projectRoot: f.projectRoot, write: (text: string) => { output += text; } });
      assert.equal(exitCode, args.length ? 0 : 1);
      assert.doesNotMatch(output, /PRIVATE_|\.runtime|\.env|instrumentation|field-guide-build-tracing|[\\/]/);
      assert.ok(Object.values(JSON.parse(output)).every(value => typeof value === "number"));
    }
    await writeFile(manifest, '{"files":[PRIVATE_MALFORMED_CONTENT');
    let malformedOutput = "";
    assert.equal(await runBuildTracingCli([], { projectRoot: f.projectRoot, write: (text: string) => { malformedOutput += text; } }), 1);
    assert.doesNotMatch(malformedOutput, /PRIVATE_|Unexpected|\.nft|[\\/]/);
    assert.equal(JSON.parse(malformedOutput).failures, 1);
  } finally { await f.close(); }
});

test("build-directory validation rejects the project root, traversal and sibling directories", async () => {
  const f = await fixture();
  try {
    for (const buildDirectory of [".", f.projectRoot, "..", join(f.projectRoot, "..", "outside-build")]) await assert.rejects(verifyBuildTracing({ projectRoot: f.projectRoot, buildDirectory, sanitize: true }), codeIs("BUILD_DIRECTORY_OUTSIDE_PROJECT"));
    const alternate = join(f.projectRoot, ".output"); await mkdir(alternate);
    await f.manifest(join(alternate, "nft.json"), ["../public/index.html"]);
    assert.equal((await verifyBuildTracing({ projectRoot: f.projectRoot, buildDirectory: ".output" })).manifestCount, 1);
    await assert.rejects(verifyBuildTracing({ projectRoot: f.projectRoot, buildDirectory: "missing" }), codeIs("BUILD_DIRECTORY_UNAVAILABLE"));
  } finally { await f.close(); }
});

test("output scans do not follow symbolic directory links outside the build tree", async t => {
  const f = await fixture();
  try {
    const outside = join(f.projectRoot, "outside"); await mkdir(outside);
    const outsideSecret = await f.file(join(outside, ".env.local"), "PRIVATE_EXTERNAL_SYMLINK_TARGET");
    await f.manifest(join(outside, "external.nft.json"), ["../.env.local"]);
    try { await symlink(outside, join(f.buildDirectory, "external-link"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("host cannot create symbolic links"); throw error; }
    const report = await verifyBuildTracing({ projectRoot: f.projectRoot, sanitize: true });
    assert.equal(report.manifestCount, 0); assert.equal(report.copiedPrivateEntries, 0);
    assert.equal(await readFile(outsideSecret, "utf8"), "PRIVATE_EXTERNAL_SYMLINK_TARGET");
    await assert.rejects(verifyBuildTracing({ projectRoot: f.projectRoot, buildDirectory: ".next/external-link", sanitize: true }), codeIs("BUILD_DIRECTORY_INVALID"));
  } finally { await f.close(); }
});
