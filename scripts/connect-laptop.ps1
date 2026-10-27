# Run locally on the server laptop in an administrator PowerShell window.
# This bootstraps a fresh Windows OpenSSH server over Tailscale only.
[CmdletBinding()]
param(
    [string]$ControllerIp,
    [string]$PublicKeyFile = (Join-Path $PSScriptRoot 'controller.pub')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-TailscaleIPv4([string]$Address) {
    $parsed = $null
    if (![System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
    if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $bytes = $parsed.GetAddressBytes()
    return $bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open PowerShell as administrator on the server laptop, then run this script.'
}
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (!(Test-Path -LiteralPath $tailscale)) { throw 'Install and log in to Tailscale first.' }
$statusText = & $tailscale status --json
if ($LASTEXITCODE -ne 0) { throw 'Unable to read Tailscale status.' }
$status = $statusText | ConvertFrom-Json
if ($status.BackendState -ne 'Running') { throw 'Log in to Tailscale on this laptop first.' }
$laptopIp = @($status.TailscaleIPs | Where-Object { Test-TailscaleIPv4 $_ }) | Select-Object -First 1
if (!$laptopIp) { throw 'This laptop has no Tailscale IPv4 address.' }
if (!$ControllerIp) {
    $controllerFile = Join-Path $PSScriptRoot 'controller.json'
    if (Test-Path -LiteralPath $controllerFile) {
        $ControllerIp = (Get-Content -LiteralPath $controllerFile -Raw | ConvertFrom-Json).address
    } else {
        $ControllerIp = Read-Host 'Enter the development computer Tailscale IPv4 (100.x.x.x)'
    }
}
if (!(Test-TailscaleIPv4 $ControllerIp) -or $ControllerIp -eq $laptopIp) {
    throw 'ControllerIp must be the OTHER computer Tailscale IPv4 address.'
}
$controllerPeer = @($status.Peer.PSObject.Properties.Value | Where-Object { $_.TailscaleIPs -contains $ControllerIp })
if ($controllerPeer.Count -ne 1 -or !$controllerPeer[0].Online) {
    throw 'The development computer must be online in the same Tailscale network.'
}
$localUser = Get-LocalUser -SID $identity.User
$loginName = $localUser.Name.ToLowerInvariant()
if ($loginName -notmatch '^[a-z0-9_.-]{1,32}$') {
    throw 'Use a local Windows administrator account with a simple English login name for bootstrap.'
}
$publicKey = (Get-Content -LiteralPath $PublicKeyFile -Raw).Trim()
if ($publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]{60,100}={0,2}( [A-Za-z0-9_.-]+)?$') {
    throw 'Expected exactly one Ed25519 public key; never copy a private key to this laptop.'
}
$sshDirectory = Join-Path $env:ProgramData 'ssh'
$configPath = Join-Path $sshDirectory 'sshd_config'
$marker = '# hackathon-laptop-private-connect-v1'
$bootstrapDirectory = Join-Path $env:ProgramData 'HackathonLaptopConnect'
$pendingPath = Join-Path $bootstrapDirectory 'pending.json'
$pendingOwned = $false
if (Test-Path -LiteralPath $pendingPath) {
    $pending = Get-Content -LiteralPath $pendingPath -Raw | ConvertFrom-Json
    $pendingOwned = $pending.version -eq 1 -and $pending.ownerSid -eq $identity.User.Value
    if (!$pendingOwned) { throw 'An unfinished bootstrap belongs to another account; review it first.' }
}
$capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
if ($capability.State -eq 'Installed') {
    $ownedConfig = (Test-Path -LiteralPath $configPath) -and (Get-Content -LiteralPath $configPath -Raw).StartsWith($marker)
    if (!$pendingOwned -and !$ownedConfig) {
        throw 'An existing OpenSSH installation needs review. No SSH configuration was changed.'
    }
} else {
    New-Item -ItemType Directory -Path $bootstrapDirectory -Force | Out-Null
    $bootstrapAcl = [System.Security.AccessControl.DirectorySecurity]::new()
    $bootstrapAcl.SetOwner($identity.User)
    $bootstrapAcl.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $sid = [System.Security.Principal.SecurityIdentifier]::new($sidValue)
        $bootstrapAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $bootstrapDirectory -AclObject $bootstrapAcl
    @{version=1;ownerSid=$identity.User.Value} | ConvertTo-Json | Set-Content -LiteralPath $pendingPath -Encoding ASCII
    $installed = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
    if ($installed.RestartNeeded) { throw 'Restart Windows to finish OpenSSH installation, then rerun this script.' }
}
$sshd = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
$keygen = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
$sshService = Get-Service -Name sshd -ErrorAction Stop
if ($sshService.Status -ne 'Stopped') {
    Stop-Service -Name sshd -ErrorAction Stop
    $sshService.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(15))
}

# Installation creates a broad TCP 22 rule. Disable it before starting sshd.
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
$ruleName = 'Hackathon-Laptop-Private-SSH'
Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Disable-NetFirewallRule
if (@(Get-NetFirewallProfile | Where-Object { !$_.Enabled -or $_.DefaultInboundAction -eq 'Allow' }).Count -gt 0) {
    throw 'Enable Windows Firewall with blocked unsolicited inbound traffic before continuing.'
}
# A second broad allow rule would bypass the restricted rule below. Stop for
# review instead of disabling unrelated policies or claiming isolation.
foreach ($rule in @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow)) {
    $portFilter = $rule | Get-NetFirewallPortFilter
    if ([string]$portFilter.Protocol -notin @('TCP', '6', 'Any', '256')) { continue }
    $coversSsh = $false
    foreach ($portValue in @($portFilter.LocalPort)) {
        if ([string]$portValue -in @('Any', '22')) { $coversSsh = $true }
        elseif ([string]$portValue -match '^(\d+)-(\d+)$' -and [int]$Matches[1] -le 22 -and [int]$Matches[2] -ge 22) { $coversSsh = $true }
    }
    if (!$coversSsh) { continue }
    $applicationFilter = $rule | Get-NetFirewallApplicationFilter
    $program = [Environment]::ExpandEnvironmentVariables([string]$applicationFilter.Program)
    if ($program -eq 'Any' -or $program -ieq $sshd -or $program -match '(?i)[\\/]sshd\.exe$') {
        throw ('Another firewall allow rule may expose SSH: ' + $rule.Name + '. Review it before continuing; sshd remains stopped.')
    }
}

New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
if (Test-Path -LiteralPath $configPath) {
    Copy-Item -LiteralPath $configPath -Destination ($configPath + '.before-hackathon-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$keyPath = Join-Path $sshDirectory 'administrators_authorized_keys'
$keys = if (Test-Path -LiteralPath $keyPath) { [System.IO.File]::ReadAllText($keyPath) } else { '' }
if ($keys -notmatch [regex]::Escape($publicKey)) {
    [System.IO.File]::WriteAllText($keyPath, $keys.TrimEnd() + "`r`n" + $publicKey + "`r`n", [System.Text.UTF8Encoding]::new($false))
}
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$adminSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$keyAcl = [System.Security.AccessControl.FileSecurity]::new()
$keyAcl.SetOwner($adminSid)
$keyAcl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($systemSid, $adminSid)) {
    $keyAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
}
Set-Acl -LiteralPath $keyPath -AclObject $keyAcl
$config = @"
$marker
Port 22
AddressFamily inet
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers $loginName
AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
AllowAgentForwarding no
AllowTcpForwarding no
GatewayPorts no
Subsystem sftp sftp-server.exe
"@
[System.IO.File]::WriteAllText($configPath, $config + "`r`n", [System.Text.UTF8Encoding]::new($false))
& $keygen -A
if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize SSH host keys.' }
& $sshd -t -f $configPath
if ($LASTEXITCODE -ne 0) { throw 'SSH configuration failed validation; sshd remains stopped.' }
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name $ruleName -Enabled True -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort 22 -LocalAddress $laptopIp -RemoteAddress $ControllerIp -Program $sshd
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName 'Hackathon laptop SSH (private controller only)' -Enabled True -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort 22 -LocalAddress $laptopIp -RemoteAddress $ControllerIp -Program $sshd | Out-Null
}
& $tailscale set --unattended=true
if ($LASTEXITCODE -ne 0) { throw 'Enable Tailscale Run unattended, then rerun this script.' }
Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd

Write-Output 'Copy the following connection information back to the development chat (no passwords):'
Write-Output ('Laptop Tailscale IP: ' + $laptopIp)
Write-Output ('SSH username: ' + $loginName)
& $keygen -lf (Join-Path $sshDirectory 'ssh_host_ed25519_key.pub') -E sha256
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the public host key fingerprint.' }
Write-Output 'Controller public key added; existing administrator keys were preserved. Password login is disabled.'
