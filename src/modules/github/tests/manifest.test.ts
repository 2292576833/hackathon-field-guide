import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildPreview, hashInput, MANIFEST_LIMITS, validateManifest } from "../manifest.ts";
import type { FileChange, GitTreeEntry } from "../types.ts";

const head = { commitSha: "1".repeat(40), treeSha: "2".repeat(40) };
const createdAt = "2026-10-08T03:00:00.000Z";
const text = (path: string, content = "hello\n", mode?: "100644" | "100755"): FileChange => ({ path, action: "upsert", content, ...(mode === undefined ? {} : { mode }) });
const blob = (path: string, mode = "100644"): GitTreeEntry => ({ path, sha: "3".repeat(40), type: "blob", mode });
function preview(changes: FileChange[], tree: GitTreeEntry[] = [], beforeByPath: Record<string, string> = {}) {
  return buildPreview({ manifest: validateManifest(changes), changes, head, tree, beforeByPath, createdAt });
}
function codes(changes: FileChange[]) {
  return validateManifest(changes).issues.map(entry => entry.code);
}

test("canonical JSON hash sorts nested object keys, preserves array order, and uses SHA-256", () => {
  assert.equal(hashInput({ z: 1, a: { y: false, x: null } }), hashInput({ a: { x: null, y: false }, z: 1 }));
  assert.equal(hashInput({ optional: undefined, data: [undefined] }), hashInput({ data: [null] }));
  assert.equal(hashInput(null), createHash("sha256").update("null").digest("hex"));
  assert.notEqual(hashInput(["first", "second"]), hashInput(["second", "first"]));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [cyclic, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => {}, new Date()]) {
    assert.throws(() => hashInput(value), { code: "INVALID_HASH_INPUT" });
  }
});

test("manifest normalizes NFC paths without mutating drafts and binds content and explicit mode", () => {
  const changes = [text("cafe\u0301.txt", "资料 😀\n"), text("src/main.ts", "export const value = 1;\n")];
  const manifest = validateManifest(changes);
  assert.equal(manifest.entries[0].path, "café.txt");
  assert.equal(changes[0].path, "cafe\u0301.txt");
  assert.equal(manifest.totalBytes, Buffer.byteLength(changes[0].content!, "utf8") + Buffer.byteLength(changes[1].content!, "utf8"));
  assert.deepEqual(manifest.issues, []);
  assert.equal(manifest.inputHash, validateManifest([...changes].reverse()).inputHash);
  assert.notEqual(manifest.inputHash, validateManifest([text("café.txt", "资料 😀\n", "100644"), changes[1]]).inputHash);
  assert.notEqual(manifest.inputHash, validateManifest([text("café.txt", "updated"), changes[1]]).inputHash);
});

test("absolute, traversal, malformed, control and overlong paths are blocked", () => {
  for (const path of ["/tmp/file", "C:/file", "C:file", "\\\\server\\file", "src\\file", "../file", "src/../file", "src/./file", "src//file", "src/", "", "nul\0.txt", "bad\ud800.txt", "a".repeat(256), "资".repeat(86)]) {
    assert.ok(codes([text(path)]).length > 0, path);
  }
  const longPath = Array.from({ length: 6 }, () => "a".repeat(200)).join("/");
  assert.ok(codes([text(longPath)]).includes("PATH_TOO_LONG"));
  assert.deepEqual(codes([text("资料/说明😀.md")]), []);
});

test("duplicate, NFC alias, case collision and selected parent-file conflicts are blocked", () => {
  assert.ok(codes([text("src/app.ts"), text("src/app.ts")]).includes("DUPLICATE_PATH"));
  assert.ok(codes([text("café.txt"), text("cafe\u0301.txt")]).includes("DUPLICATE_PATH"));
  assert.ok(codes([text("README.md"), text("readme.md")]).includes("PATH_CASE_COLLISION"));
  assert.ok(codes([text("src/main.ts"), text("Src/helper.ts")]).includes("PATH_CASE_COLLISION"));
  assert.ok(codes([{ path: "src", action: "delete" }, text("SRC/app.ts")]).includes("PATH_ANCESTOR_CONFLICT"));
});

test("Git internals, dependencies, build output and workflows cannot be selected even for deletion", () => {
  for (const path of [".git/config", "nested/.GIT/HEAD", "node_modules/lib/index.js", ".next/page.js", "dist/index.js", "build/output.js", ".github/workflows/build.yml", ".GitHub/WorkFlows/check.yml"]) {
    assert.ok(codes([text(path)]).some(code => code === "EXCLUDED_PATH" || code === "WORKFLOW_PATH_BLOCKED"), path);
    assert.ok(codes([{ path, action: "delete" }]).length > 0, path);
  }
  assert.deepEqual(codes([text(".github/ISSUE_TEMPLATE/bug.md"), text("src/building.ts")]), []);
});

test("credential paths are blocked while ordinary source and environment references remain usable", () => {
  for (const path of [".env", ".env.local", "config/.env.example", ".npmrc", ".aws/credentials", ".ssh/id_ed25519", "config/credentials.json", "service-account-prod.json", "private.key", "cert.pem", "kubeconfig"]) {
    assert.ok(codes([text(path)]).includes("CREDENTIAL_FILE_BLOCKED"), path);
  }
  assert.deepEqual(codes([text("src/config.ts", "export const apiKey = process.env.API_KEY;\nexport const password = getenv('PASSWORD');\n")]), []);
  assert.deepEqual(codes([text("README.md", 'api_key = "YOUR_API_KEY_HERE"\nsecret = "replace-this-value"\n')]), []);
});

test("known credentials and suspicious literals block a draft without retaining discovered values", () => {
  const values = ["ghp_" + "A".repeat(36), "github_pat_" + "B".repeat(30), "sk-proj-" + "C".repeat(40), "AKIA" + "D".repeat(16), "-----BEGIN PRIVATE KEY-----", "postgres://participant:secret-password@db.example/team", 'api_key = "a-real-key-1234567890"', "password: a-real-password-123"];
  for (const value of values) {
    const manifest = validateManifest([text("src/config.txt", value)]);
    assert.ok(manifest.issues.some(entry => entry.code === "SUSPECTED_SECRET"));
    assert.ok(!JSON.stringify(manifest).includes(value));
    const result = preview([text("src/config.txt", value)]);
    assert.equal(result.files[0].after, null);
    assert.ok(!JSON.stringify(result).includes(value));
  }
});

test("UTF-8 text supports tabs, CR/LF and paired surrogates but blocks NUL, binary controls and isolated surrogates", () => {
  assert.deepEqual(codes([text("README.md", "title\r\n\t资料 😀\n")]), []);
  for (const content of ["nul\0byte", "escape\u001b[31m", "binary\u0002value", "delete\u007fvalue", "c1\u0085value", "bad\ud800value", "bad\udc00value"]) {
    assert.ok(codes([text("README.md", content)]).includes("UNSUPPORTED_TEXT"));
  }
});

test("file-count and byte limits enforce exact boundary values and UTF-8 size", () => {
  const exactFile = "😀".repeat(MANIFEST_LIMITS.fileBytes / 4);
  assert.deepEqual(codes([text("one.txt", exactFile)]), []);
  assert.ok(codes([text("one.txt", exactFile + "x")]).includes("FILE_TOO_LARGE"));
  const files = Array.from({ length: 100 }, (_, index) => text(`${index}.txt`, ""));
  assert.deepEqual(codes(files), []);
  assert.ok(codes([...files, text("extra.txt", "")]).includes("FILE_COUNT_EXCEEDED"));
  const five = Array.from({ length: 5 }, (_, index) => text(`${index}.txt`, "a".repeat(MANIFEST_LIMITS.fileBytes)));
  assert.equal(validateManifest(five).totalBytes, MANIFEST_LIMITS.totalBytes);
  assert.deepEqual(codes(five), []);
  assert.ok(codes([...five, text("extra.txt", "x")]).includes("TOTAL_SIZE_EXCEEDED"));
});

test("deletion must be explicit and contain neither replacement content nor mode", () => {
  assert.deepEqual(codes([{ path: "old.md", action: "delete" }]), []);
  assert.ok(codes([{ path: "old.md", action: "delete", content: "" }]).includes("DELETE_HAS_CONTENT"));
  assert.ok(codes([{ path: "old.md", action: "delete", mode: "100644" }]).includes("DELETE_HAS_CONTENT"));
  assert.ok(codes([{ path: "new.md", action: "upsert" }]).includes("TEXT_CONTENT_REQUIRED"));
  assert.ok(codes([]).includes("EMPTY_MANIFEST"));
});

test("preview shows add, modify and explicit deletion with actual before/after while preserving unselected paths", () => {
  const changes: FileChange[] = [text("new.md", "new\n"), text("README.md", "after\n"), { path: "old.md", action: "delete" }];
  const tree = [blob("README.md"), blob("old.md"), blob("unselected.md")];
  const result = preview(changes, tree, { "README.md": "before\n", "old.md": "old\n", "unselected.md": "keep\n" });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.files, [
    { path: "README.md", action: "modify", before: "before\n", after: "after\n", beforeMode: "100644", afterMode: "100644" },
    { path: "new.md", action: "add", before: null, after: "new\n", beforeMode: null, afterMode: "100644" },
    { path: "old.md", action: "delete", before: "old\n", after: null, beforeMode: "100644", afterMode: null },
  ]);
  assert.equal(result.baseHeadSha, head.commitSha);
  assert.equal(result.baseTreeSha, head.treeSha);
  assert.equal(tree[2].path, "unselected.md");
});

test("unrequested executable mode is preserved, explicit mode-only changes appear in the preview", () => {
  const tree = [blob("run.sh", "100755")];
  const unchanged = preview([text("run.sh", "#!/bin/sh\n")], tree, { "run.sh": "#!/bin/sh\n" });
  assert.equal(unchanged.files[0].afterMode, "100755");
  assert.equal(unchanged.files[0].action, "unchanged");
  assert.ok(unchanged.issues.some(entry => entry.code === "NO_CHANGES"));
  const changed = preview([text("run.sh", "#!/bin/sh\n", "100644")], tree, { "run.sh": "#!/bin/sh\n" });
  assert.equal(changed.files[0].action, "modify");
  assert.equal(changed.files[0].afterMode, "100644");
  assert.deepEqual(changed.issues, []);
  assert.notEqual(unchanged.previewHash, changed.previewHash);
});

test("preview rejects stale manifest and binds remote base, time and displayed content to confirmation hash", () => {
  const changes = [text("README.md", "new")];
  const manifest = validateManifest(changes);
  const first = buildPreview({ manifest, changes, head, tree: [], beforeByPath: {}, createdAt });
  const changed = buildPreview({ manifest, changes: [text("README.md", "changed")], head, tree: [], beforeByPath: {}, createdAt });
  assert.ok(changed.issues.some(entry => entry.code === "MANIFEST_MISMATCH"));
  assert.notEqual(first.previewHash, changed.previewHash);
  assert.notEqual(first.previewHash, buildPreview({ manifest, changes, head: { ...head, commitSha: "4".repeat(40) }, tree: [], beforeByPath: {}, createdAt }).previewHash);
  assert.notEqual(first.previewHash, buildPreview({ manifest, changes, head, tree: [], beforeByPath: {}, createdAt: "2026-10-08T03:01:00.000Z" }).previewHash);
});

test("deleting missing paths, directories, symlinks and submodules is blocked", () => {
  assert.ok(preview([{ path: "missing.md", action: "delete" }]).issues.some(entry => entry.code === "DELETE_TARGET_MISSING"));
  for (const remote of [blob("selected", "120000"), { ...blob("selected", "160000"), type: "commit" as const }, { ...blob("selected", "040000"), type: "tree" as const }]) {
    const result = preview([{ path: "selected", action: "delete" }], [remote]);
    assert.ok(result.issues.some(entry => entry.code === "UNSUPPORTED_REMOTE_FILE" || entry.code === "REMOTE_PATH_IS_DIRECTORY"));
  }
  assert.ok(preview([text("folder", "replace")], [blob("folder/a.txt")]).issues.some(entry => entry.code === "REMOTE_PATH_IS_DIRECTORY"));
});

test("remote file, symlink and submodule parents block nested writes", () => {
  for (const remote of [blob("src"), blob("src", "120000"), { ...blob("src", "160000"), type: "commit" as const }]) {
    assert.ok(preview([text("src/main.ts")], [remote]).issues.some(entry => entry.code === "REMOTE_ANCESTOR_NOT_DIRECTORY"));
  }
  const result = preview([text("src/main.ts")], [{ ...blob("src", "040000"), type: "tree" }]);
  assert.deepEqual(result.issues, []);
});

test("remote filename and parent-directory case or NFC collisions block silent duplicates", () => {
  assert.ok(preview([text("readme.md")], [blob("README.md")]).issues.some(entry => entry.code === "REMOTE_PATH_COLLISION"));
  assert.ok(preview([text("src/main.ts")], [{ ...blob("Src", "040000"), type: "tree" }]).issues.some(entry => entry.code === "REMOTE_PATH_COLLISION"));
  assert.ok(preview([text("src/main.ts")], [blob("Src/unselected.ts")]).issues.some(entry => entry.code === "REMOTE_PATH_COLLISION"));
  assert.ok(preview([text("café.txt")], [blob("cafe\u0301.txt")], { "cafe\u0301.txt": "before" }).issues.some(entry => entry.code === "REMOTE_PATH_COLLISION"));
  assert.ok(preview([text("README.md")], [blob("README.md"), blob("readme.md")], { "README.md": "before" }).issues.some(entry => entry.code === "REMOTE_PATH_COLLISION"));
});

test("missing or unsupported remote content is blocked and suspect remote credentials are hidden", () => {
  assert.ok(preview([text("README.md")], [blob("README.md")]).issues.some(entry => entry.code === "REMOTE_CONTENT_MISSING"));
  const binary = preview([text("README.md")], [blob("README.md")], { "README.md": "binary\0content" });
  assert.ok(binary.issues.some(entry => entry.code === "UNSUPPORTED_REMOTE_TEXT"));
  assert.equal(binary.files[0].before, null);
  const secret = "ghp_" + "Z".repeat(36);
  const result = preview([text("README.md")], [blob("README.md")], { "README.md": secret });
  assert.ok(result.issues.some(entry => entry.code === "REMOTE_SUSPECTED_SECRET"));
  assert.equal(result.files[0].before, null);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("archive/binary attachment paths and LFS pointers cannot enter the ordinary-text save flow", () => {
  for (const path of ["bundle.zip", "files.TAR", "demo.pdf", "video.mp4", "data.sqlite", "model.bin"]) assert.ok(codes([text(path, "ordinary-looking text")]).includes("UNSUPPORTED_UPLOAD_TYPE"), path);
  for (const prefix of ["", "\uFEFF"]) assert.ok(codes([text("large-data.txt", `${prefix}version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 10000\n`)]).includes("LFS_POINTER_BLOCKED"));
  assert.ok(!validateManifest([text("diagram.svg", "<svg></svg>")]).issues.length);
  // Explicit removal of an unsupported old attachment remains a legitimate deletion.
  assert.ok(!validateManifest([{ path: "bundle.zip", action: "delete" }]).issues.length);
});
