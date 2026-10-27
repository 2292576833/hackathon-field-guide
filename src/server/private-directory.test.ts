import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { protectPrivateDirectory } from "../shared/private-directory.ts";

test("private session permissions protect newly written descendants on the actual host filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-private-acl-"));
  try {
    await protectPrivateDirectory(root);
    const child = join(root, "home"); await mkdir(child);
    const file = join(child, "fixture-grant.json"); await writeFile(file, "FIXTURE_ONLY_NO_CREDENTIAL");
    if (process.platform === "win32") {
      const script = `$ErrorActionPreference='Stop'; $owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $root=Get-Acl -LiteralPath $env:ACL_TEST_ROOT; $file=Get-Acl -LiteralPath $env:ACL_TEST_FILE; $rules=@($file.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); [Console]::Write(($root.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $owner -and $rules[0].AccessControlType -eq 'Allow').ToString())`;
      const { stdout } = await promisify(execFile)(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, shell: false, timeout: 8000, env: { NODE_ENV: "production", SystemRoot: process.env.SystemRoot, ACL_TEST_ROOT: root, ACL_TEST_FILE: file } });
      assert.equal(stdout, "True");
    } else assert.equal((await stat(root)).mode & 0o777, 0o700);
  } finally {
    assert.equal(dirname(root), tmpdir()); assert.ok(relative(tmpdir(), root).startsWith("dsh-private-acl-") && !relative(tmpdir(), root).includes(sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("private directory protection refuses a junction or symlink and does not change its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-private-boundary-"));
  try {
    const target = join(root, "target"), link = join(root, "link"); await mkdir(target);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(protectPrivateDirectory(link), /Private session directory protection failed/);
    assert.ok((await stat(target)).isDirectory());
  } finally {
    assert.equal(dirname(root), tmpdir()); assert.ok(relative(tmpdir(), root).startsWith("dsh-private-boundary-") && !relative(tmpdir(), root).includes(sep));
    await rm(root, { recursive: true, force: true });
  }
});
