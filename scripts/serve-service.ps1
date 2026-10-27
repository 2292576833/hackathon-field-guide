# Website start / stop / status script (Windows, ASCII-only on purpose).
#
# Why this exists: starting the site through a session-attached pipeline
# (npm.cmd run start | Tee-Object) deadlocks when the pipeline reader stops
# consuming output. The child process then spins on a blocked stdout write:
# it keeps the port bound but stops accepting connections.
# This script starts the site detached from the terminal session and redirects
# stdout/stderr to log files instead of a pipe.
#
# Usage (run from the project root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serve-service.ps1 start
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serve-service.ps1 status
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serve-service.ps1 stop
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serve-service.ps1 restart

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'restart')]
  [string]$Action = 'status',

  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

$scriptPath = $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $scriptPath)
$runtime = Join-Path $root '.runtime'
$logDir = Join-Path $runtime 'logs'
$pidFile = Join-Path $runtime 'serve.pid'
$lockFile = Join-Path $runtime 'serve.lock'
$nextBin = Join-Path $root 'node_modules\next\dist\bin\next'

function Get-AlivePid {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $text = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
  if (-not $text) { return $null }
  $value = 0
  if (-not [int]::TryParse($text.Trim(), [ref]$value)) { return $null }
  if ($value -le 0) { return $null }
  if (Get-Process -Id $value -ErrorAction SilentlyContinue) { return $value }
  return $null
}

function Test-PortListening {
  param([int]$P)
  return [bool](Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue)
}

function Test-Accepting {
  # A listening port does not prove the process is healthy. Open a real TCP
  # connection so a spinning/wedged process (bound port, no accept) is detected.
  param([int]$P)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $P)
    if (-not $task.Wait(3000)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Invoke-Stop {
  $targets = @()
  $filePid = Get-AlivePid -Path $pidFile
  if ($filePid) { $targets += $filePid }
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($l in $listeners) { if ($targets -notcontains $l.OwningProcess) { $targets += $l.OwningProcess } }

  if ($targets.Count -eq 0) {
    Write-Host "[service] No running site process found."
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
    return 0
  }

  # Windows process termination does not give PGlite time to checkpoint.
  # The signed local controller rejects new API work and closes storage first.
  Push-Location $root
  try {
    & (Get-Command node).Source --experimental-strip-types (Join-Path $root 'scripts\stop-server.mts') | ForEach-Object { Write-Host $_ }
    $stopResult = $LASTEXITCODE
  } finally { Pop-Location }
  if ($stopResult -ne 0) {
    Write-Warning "[service] Graceful stop has not completed. The process was not forced off; do not open or copy its database."
    return 1
  }

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-PortListening -P $Port)) { break }
  }

  if (Test-PortListening -P $Port) {
    Write-Warning "[service] Port $Port is still bound, please check manually."
    return 1
  }

  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
  Write-Host "[service] Stopped, port $Port released."
  return 0
}

function Show-Status {
  $filePid = Get-AlivePid -Path $pidFile
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  $listenerPid = if ($listeners) { ($listeners | Select-Object -First 1).OwningProcess } else { $null }
  $accepting = if ($listenerPid) { Test-Accepting -P $Port } else { $false }

  [pscustomobject]@{
    PortListening = [bool]$listenerPid
    ListenerPid   = $listenerPid
    RecordedPid   = $filePid
    AcceptingTCP  = $accepting
    NextEntry     = (Test-Path -LiteralPath $nextBin)
    LogDir        = $logDir
  } | Format-List | Out-String | Write-Host

  if ($listenerPid -and -not $accepting) {
    Write-Warning "[service] Port is bound but refusing connections (wedged process). Run stop, then start."
    return 1
  }
  if (-not $listenerPid) {
    Write-Host "[service] Site is not running."
    return 1
  }
  Write-Host "[service] Site is running."
  return 0
}

switch ($Action) {
  'stop' { exit (Invoke-Stop) }
  'status' { exit (Show-Status) }
  'restart' { if ((Invoke-Stop) -ne 0) { exit 1 } }
}

if ($Action -in @('start', 'restart')) {
  if (Test-PortListening -P $Port) {
    if (Test-Accepting -P $Port) {
      Write-Host "[service] Site already running and accepting connections, not starting a second instance."
      exit 0
    }
    Write-Warning "[service] Port $Port is bound but refusing connections, stopping it first."
    if ((Invoke-Stop) -ne 0) { exit 1 }
  }

  if (-not (Test-Path -LiteralPath $nextBin)) { throw "Next entry not found: $nextBin. Install dependencies first." }
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $outLog = Join-Path $logDir "site-$stamp.out.log"
  $errLog = Join-Path $logDir "site-$stamp.err.log"

  $env:FIELD_GUIDE_SERVE = '1'
  $proc = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList @($nextBin, 'start', '--hostname', '127.0.0.1', '--port', "$Port") `
    -WorkingDirectory $root `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden -PassThru

  Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ASCII
  Set-Content -LiteralPath $lockFile -Value "$($proc.Id) $stamp" -Encoding ASCII

  Write-Host "[service] Started PID $($proc.Id)"
  Write-Host "[service] stdout: $outLog"
  Write-Host "[service] stderr: $errLog"

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) { Write-Warning "[service] Process exited with code $($proc.ExitCode), check the error log."; break }
    if (Test-Accepting -P $Port) { $ready = $true; break }
  }

  if ($ready) { Write-Host "[service] Ready, listening on 127.0.0.1:$Port." }
  else { Write-Warning "[service] Could not confirm accepting connections within the wait window, check the logs." }
  exit 0
}
