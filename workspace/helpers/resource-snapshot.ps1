# StakeMode resource sampling. No caller data is executed by this script.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = [Collections.Generic.List[object]]::new()
try {
    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 8192) { exit 3 }
    $request = $inputText | ConvertFrom-Json
    $selected = $null
    if ($null -ne $request.roots) {
        if ($request.roots -isnot [Array] -or $request.roots.Count -gt 256) { exit 3 }
        $selected = @{}
        foreach ($rootId in $request.roots) {
            $number = 0
            if (-not [int]::TryParse([string]$rootId, [ref]$number) -or $number -lt 1) { exit 3 }
            $selected[$number] = $true
        }
    }
} catch { exit 3 }
$query = [Diagnostics.Stopwatch]::StartNew()
try {
    $processes = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate FROM Win32_Process' -OperationTimeoutSec 6)
} catch { exit 2 }
$query.Stop()
$rowSelection = $selected
$probeSet = $selected
if ($null -eq $probeSet) {
    $probeSet = @{}
    foreach ($record in $processes) {
        # Default inspection retains the full CIM table. Its only native
        # resource probes are browser profile roots (including quoted flags).
        if ([string]$record.CommandLine -match '(?i)(?:^|\s)"?(?:--user-data-dir=|-profile(?:\s|"?(?=\s|$)))') {
            $probeSet[[int]$record.ProcessId] = $true
        }
    }
}
# CIM supplies the complete parent table once. Only browser roots and their
# descendants need comparatively expensive native CPU/RSS reads.
do {
    $changed = $false
    foreach ($record in $processes) {
        $processId = [int]$record.ProcessId
        if (-not $probeSet.ContainsKey($processId) -and $probeSet.ContainsKey([int]$record.ParentProcessId)) {
            $probeSet[$processId] = $true
            $changed = $true
        }
    }
} while ($changed)
$nativeTimer = [Diagnostics.Stopwatch]::StartNew()
$probeCount = 0
foreach ($record in $processes) {
    if ($null -ne $rowSelection -and -not $rowSelection.ContainsKey([int]$record.ProcessId)) { continue }
    $created = $null
    try { if ($null -ne $record.CreationDate) { $created = $record.CreationDate.ToUniversalTime() } } catch { }
    # Keep the complete CIM identity even when an OS permission check or a
    # process exit prevents CPU/RSS access. Missing counters are never zeros.
    $row = [PSCustomObject]@{
        pid = [int]$record.ProcessId
        parentPid = [int]$record.ParentProcessId
        startToken = $null
        createdAtMs = $null
        executablePath = [string]$record.ExecutablePath
        commandLine = [string]$record.CommandLine
        nativeVerified = $false
        cpuSeconds = $null
        rssBytes = $null
    }
    if ($null -ne $created) {
        $row.startToken = [string]$created.Ticks
        $row.createdAtMs = [double]([DateTimeOffset]$created).ToUnixTimeMilliseconds()
    }
    if ($probeSet.ContainsKey([int]$record.ProcessId)) {
      $probeCount++
      try {
        $native = Get-Process -Id $record.ProcessId -ErrorAction Stop
        $started = $native.StartTime.ToUniversalTime()
        # A PID replaced between the CIM snapshot and Get-Process is ambiguous.
        if ($null -ne $created -and [Math]::Abs(($started - $created).TotalMilliseconds) -le 2000) {
            $cpu = $native.CPU
            if ($null -eq $cpu) { throw 'Native CPU counter is unavailable' }
            $cpuSeconds = [double]$cpu
            $rssBytes = [double]$native.WorkingSet64
            $row.startToken = [string]$started.Ticks
            $row.createdAtMs = [double]([DateTimeOffset]$started).ToUnixTimeMilliseconds()
            $row.cpuSeconds = $cpuSeconds
            $row.rssBytes = $rssBytes
            $row.nativeVerified = $true
        }
      } catch { }
    }
    $rows.Add($row)
}
$nativeTimer.Stop()
ConvertTo-Json -InputObject ([ordered]@{ rows = @($rows.ToArray()); candidateCount = $processes.Count; probeCount = $probeCount; queryMs = $query.ElapsedMilliseconds; nativeMs = $nativeTimer.ElapsedMilliseconds }) -Depth 4 -Compress
