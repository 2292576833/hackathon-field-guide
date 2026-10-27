import { execFile } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const protectWindows = `
$ErrorActionPreference = 'Stop'
try {
  $target = $env:DSH_PRIVATE_SESSION_DIRECTORY
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $info = [System.IO.DirectoryInfo]::new($target)
  $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
  $acl = $info.GetAccessControl($sections)
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'owner' }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($entry) }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.SetAccessRule($rule)
  # Persist only the modified DACL. Set-Acl can attempt a SACL write and require
  # SeSecurityPrivilege on existing protected directories; do not request it.
  $info.SetAccessControl($acl)
  $check = $info.GetAccessControl($sections)
  $rules = @($check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (!$check.AreAccessRulesProtected -or $check.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $owner.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl' -or $rules[0].InheritanceFlags -ne 'ContainerInherit, ObjectInherit') { throw 'privacy' }
  [Console]::Write('secured')
} catch { exit 1 }
`;

/** Only call on a freshly created, owned session directory, before writing secrets.
 * Unix mode bits do not protect Windows files; establish and verify an owner-only
 * inheritable NTFS ACL instead. Failure must prevent launching the provider. */
export async function protectPrivateDirectory(directory: string): Promise<void> {
  try {
    if (!isAbsolute(directory)) throw new Error();
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error();
    if (process.platform !== "win32") { await chmod(directory, 0o700); return; }
    if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) throw new Error();
    const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await run(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(protectWindows, "utf16le").toString("base64")], {
      windowsHide: true, shell: false, timeout: 8000, maxBuffer: 4096,
      env: { NODE_ENV: "production", SystemRoot: process.env.SystemRoot, DSH_PRIVATE_SESSION_DIRECTORY: directory },
    });
    if (stdout !== "secured") throw new Error();
  } catch { throw new Error("Private session directory protection failed"); }
}
