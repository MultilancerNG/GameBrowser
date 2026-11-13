#Requires -Version 7.0

[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$InstallerPath,
  [Parameter(Mandatory)] [string]$ChecksumsPath,
  [Parameter(Mandatory)] [string]$ExpectedVersion,
  [Parameter(Mandatory)] [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This smoke test requires a fresh GitHub-hosted Windows runner'
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$checksums = (Resolve-Path -LiteralPath $ChecksumsPath).Path
$report = [IO.Path]::GetFullPath($ReportPath)
$installRoot = Join-Path $env:LOCALAPPDATA 'GameBrowser'
$stateRoot = Join-Path $env:APPDATA 'ng.solomon.gamebrowser'
if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $stateRoot)) {
  throw 'Refusing to reuse an existing GameBrowser installation or profile directory'
}

$runRoot = Join-Path $env:RUNNER_TEMP ('gamebrowser-smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$checks = [ordered]@{}
$stage = 'checksum'
$failure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$stateOwned = $false
$installed = $false
$desktop = $null
$hiddenModules = $null
$checkoutModules = Join-Path $env:GITHUB_WORKSPACE 'node_modules'

function Test-WithinRoot([string]$Path, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $candidate.Equals($base, [StringComparison]::OrdinalIgnoreCase) -or
    $candidate.StartsWith("$base\", [StringComparison]::OrdinalIgnoreCase)
}

function Stop-OwnedProcesses {
  foreach ($record in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $owned = $record.ExecutablePath -and (Test-WithinRoot ([string]$record.ExecutablePath) $installRoot)
    if (-not $owned -and $stateOwned -and $record.CommandLine) {
      $owned = $record.CommandLine.Contains($stateRoot, [StringComparison]::OrdinalIgnoreCase)
    }
    if (-not $owned) { continue }
    $process = Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue
    if ($process) {
      try { $process.Kill($true); $null = $process.WaitForExit(15000) } catch { }
    }
  }
}

function Run-WithTimeout([string]$Executable, [string[]]$Arguments, [int]$TimeoutMs) {
  $start = @{ FilePath = $Executable; PassThru = $true; WorkingDirectory = $runRoot }
  if ($Arguments.Count -gt 0) { $start.ArgumentList = $Arguments }
  $process = Start-Process @start
  if (-not $process.WaitForExit($TimeoutMs)) {
    try { $process.Kill($true) } catch { }
    throw 'Installed application operation timed out'
  }
  if ($process.ExitCode -ne 0) { throw "Installed application operation exited with code $($process.ExitCode)" }
}

try {
  $name = [IO.Path]::GetFileName($installer)
  $entries = @([IO.File]::ReadAllLines($checksums) | Where-Object { $_ -match ('^[a-f0-9]{64}  ' + [regex]::Escape($name) + '$') })
  if ($entries.Count -ne 1) { throw 'Installer must have exactly one checksum entry' }
  $expectedHash = $entries[0].Substring(0, 64)
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) {
    throw 'Installer checksum mismatch'
  }
  $checks.installerChecksum = $true

  $stage = 'silent-install'
  # Exercise the actual default per-user installation directory, without /D.
  $installed = $true
  Run-WithTimeout -Executable $installer -Arguments @('/S') -TimeoutMs 300000
  $app = Join-Path $installRoot 'gamebrowser.exe'
  $sidecar = Join-Path $installRoot 'aliasmode-sidecar.exe'
  $helper = Join-Path $installRoot 'aliasmode-mcp.exe'
  $node = Join-Path $installRoot 'playwright\node\node.exe'
  foreach ($file in @($app, $sidecar, $helper, $node, (Join-Path $installRoot 'playwright\agent\runtime-client.mjs'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Installed runtime file is missing: $([IO.Path]::GetFileName($file))" }
  }
  $checks.defaultPerUserInstall = $true
  $checks.packagedRuntimeFiles = $true

  # Installed startup must not borrow packages from the build checkout.
  if (Test-Path -LiteralPath $checkoutModules -PathType Container) {
    $hiddenModules = Join-Path $runRoot 'checkout-node_modules'
    Move-Item -LiteralPath $checkoutModules -Destination $hiddenModules
  }

  $stage = 'installed-mcp-helper'
  $helperOut = Join-Path $runRoot 'helper-version.json'
  $helperErr = Join-Path $runRoot 'helper-version.stderr'
  $helperProcess = Start-Process -FilePath $helper -ArgumentList @('version') -WorkingDirectory $runRoot -PassThru -RedirectStandardOutput $helperOut -RedirectStandardError $helperErr
  if (-not $helperProcess.WaitForExit(30000)) {
    $helperProcess.Kill($true)
    throw 'Installed MCP helper version check timed out'
  }
  if ($helperProcess.ExitCode -ne 0) { throw 'Installed MCP helper could not start its packaged sidecar' }
  $helperVersion = Get-Content -LiteralPath $helperOut -Raw | ConvertFrom-Json
  if (-not $helperVersion.ok -or $helperVersion.result.version -cne $ExpectedVersion) { throw 'Installed MCP helper version mismatch' }
  $checks.installedMcpHelper = $true

  $stage = 'background-desktop-health'
  New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
  $stateOwned = $true
  # A fresh Local workspace has no profiles, so startup cannot download or launch a browser engine.
  [IO.File]::WriteAllText((Join-Path $stateRoot 'config.json'), '{"version":1,"mode":"local","localAnalytics":false}')
  $descriptorPath = Join-Path $stateRoot 'agent-runtime.json'
  $desktop = Start-Process -FilePath $app -ArgumentList @('--background') -WorkingDirectory $runRoot -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(180)
  $descriptor = $null
  $health = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $desktop.Refresh()
    if ($desktop.HasExited) { throw 'Installed desktop exited before becoming ready' }
    try {
      $candidate = Get-Content -LiteralPath $descriptorPath -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($candidate.protocol -ceq 'aliasmode-runtime-v1' -and $candidate.appVersion -ceq $ExpectedVersion -and
          $candidate.readiness -ceq 'local' -and $candidate.desktopPid -eq $desktop.Id -and $candidate.port -gt 0) {
        $probe = Invoke-RestMethod "http://127.0.0.1:$($candidate.port)/ui/api/health" -TimeoutSec 3
        if ($probe.ok -and $probe.version -ceq $ExpectedVersion -and $probe.instance -ceq $candidate.generation -and
            (Test-WithinRoot ([string]$probe.root) $stateRoot)) {
          $descriptor = $candidate
          $health = $probe
          break
        }
      }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $descriptor -or -not $health) { throw 'Installed desktop did not publish matching Local runtime health' }
  $base = "http://127.0.0.1:$($descriptor.port)"
  $mode = Invoke-RestMethod "$base/ui/api/app-mode" -TimeoutSec 5
  if ($mode.mode -cne 'local' -or $mode.localAnalytics -ne $false) { throw 'Installed desktop did not retain Local mode' }
  $roster = Invoke-RestMethod "$base/ui/api/profiles" -TimeoutSec 5
  if (@($roster.profiles).Count -ne 0) { throw 'Fresh smoke workspace unexpectedly contains profiles' }
  $downloads = Invoke-RestMethod "$base/ui/api/runtime-downloads" -TimeoutSec 5
  if (@($downloads.downloads).Count -ne 0) { throw 'Fresh empty Local workspace unexpectedly downloads a browser engine' }
  $sidecarProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($descriptor.sidecarPid)"
  if (-not $sidecarProcess -or -not (Test-WithinRoot ([string]$sidecarProcess.ExecutablePath) $installRoot)) {
    throw 'Runtime health did not belong to the installed sidecar'
  }
  $checks.backgroundDesktopHealth = $true
  $checks.independentFromCheckout = $true
  $checks.localModeWithoutAccount = $true
  $checks.noProfileOrEngineDownloads = $true

  $stage = 'desktop-window-shutdown'
  Run-WithTimeout -Executable $app -Arguments @() -TimeoutMs 15000
  $windowDeadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $desktop.Refresh()
    if ($desktop.MainWindowHandle -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $windowDeadline)
  if ($desktop.MainWindowHandle -eq [IntPtr]::Zero -or -not $desktop.CloseMainWindow()) { throw 'Installed desktop did not reveal a closeable main window' }
  if (-not $desktop.WaitForExit(30000)) { throw 'Installed desktop did not shut down after its window closed' }
  $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $cleanupDeadline -and (Get-Process -Id $descriptor.sidecarPid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 300 }
  if (Get-Process -Id $descriptor.sidecarPid -ErrorAction SilentlyContinue) { throw 'Packaged sidecar survived desktop shutdown' }
  if (Test-Path -LiteralPath $descriptorPath) { throw 'Runtime descriptor survived desktop shutdown' }
  $checks.singleInstanceReveal = $true
  $checks.gracefulShutdown = $true

  $stage = 'silent-uninstall'
  $retainedRoot = Join-Path $stateRoot 'profiles\smoke-retained-profile'
  New-Item -ItemType Directory -Path $retainedRoot -Force | Out-Null
  $retainedProof = Join-Path $retainedRoot 'session.keep'
  [IO.File]::WriteAllText($retainedProof, 'gamebrowser-smoke-retained-data')
  Run-WithTimeout -Executable (Join-Path $installRoot 'uninstall.exe') -Arguments @('/S') -TimeoutMs 120000
  $installed = $false
  $uninstallDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $uninstallDeadline -and (Test-Path -LiteralPath $app -PathType Leaf)) { Start-Sleep -Milliseconds 300 }
  if (Test-Path -LiteralPath $app -PathType Leaf) { throw 'Silent uninstall left the installed desktop executable behind' }
  if (-not (Test-Path -LiteralPath $retainedProof -PathType Leaf) -or
      [IO.File]::ReadAllText($retainedProof) -cne 'gamebrowser-smoke-retained-data') { throw 'Silent uninstall removed retained profile data' }
  $checks.silentUninstall = $true
  $checks.retainsProfileData = $true
  $stage = 'complete'
} catch {
  $failure = $_.Exception.Message
} finally {
  try { Stop-OwnedProcesses } catch { $cleanupFailures.Add('Owned process cleanup failed') }
  if ($installed -and (Test-Path -LiteralPath (Join-Path $installRoot 'uninstall.exe') -PathType Leaf)) {
    try { Run-WithTimeout -Executable (Join-Path $installRoot 'uninstall.exe') -Arguments @('/S') -TimeoutMs 120000 } catch { $cleanupFailures.Add('Installed application cleanup failed') }
  }
  # Only fresh state created by this script is removed; an existing directory is rejected above.
  if ($stateOwned) {
    try { Remove-Item -LiteralPath $stateRoot -Recurse -Force } catch { $cleanupFailures.Add('Smoke state cleanup failed') }
  }
  if ($hiddenModules -and (Test-Path -LiteralPath $hiddenModules)) {
    try { Move-Item -LiteralPath $hiddenModules -Destination $checkoutModules } catch { $cleanupFailures.Add('Build dependency restoration failed') }
  }
  $parent = Split-Path $report -Parent
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [ordered]@{
    version = 1
    applicationVersion = $ExpectedVersion
    success = (-not $failure -and $cleanupFailures.Count -eq 0)
    stage = $stage
    checks = $checks
    error = $failure
    cleanupFailures = $cleanupFailures.ToArray()
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $report -Encoding utf8
  if (-not $hiddenModules -or -not (Test-Path -LiteralPath $hiddenModules)) {
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($failure) { throw "Windows installed smoke failed at ${stage}: $failure" }
if ($cleanupFailures.Count -gt 0) { throw 'Windows installed smoke cleanup failed; see the smoke report' }
Write-Output "GameBrowser $ExpectedVersion silent install, Local startup, MCP helper, shutdown and uninstall smoke passed"
