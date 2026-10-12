param(
  [Parameter(Mandatory)] [string] $Target,
  [Parameter(Mandatory)] [string] $OutFile,
  [string] $ExtraArgs = ""
)
# Runs REA analyze-javascript-application on $Target, writes JSON to $OutFile,
# samples the process tree's summed working set every 200ms, prints metrics.
$ErrorActionPreference = 'Stop'
$rea = if ($env:REA_MJS) { $env:REA_MJS } else { throw 'Set REA_MJS to the path of rea-agents/scripts/rea.mjs (rea-agents@6.4.0)' }
$errFile = "$OutFile.stderr.txt"

$argList = @("`"$rea`"", 'analyze-javascript-application', "`"$Target`"", '--format', 'json') + ($ExtraArgs -split ' ' | Where-Object { $_ })
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath 'node' -ArgumentList $argList -RedirectStandardOutput $OutFile -RedirectStandardError $errFile -NoNewWindow -PassThru
$null = $p.Handle

function Get-TreeIds([int]$root, $all) {
  $ids = @($root)
  $frontier = @($root)
  while ($frontier.Count) {
    $next = @($all | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
    $ids += $next; $frontier = $next
  }
  $ids
}

$peak = 0; $peakProcs = 0
while (-not $p.HasExited) {
  try {
    $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize
    $ids = Get-TreeIds $p.Id $all
    $ws = ($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum
    if ($ws -gt $peak) { $peak = $ws; $peakProcs = $ids.Count }
  } catch {}
  Start-Sleep -Milliseconds 200
}
$p.WaitForExit()
$sw.Stop()

$inBytes = (Get-ChildItem -LiteralPath $Target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
$inFiles = (Get-ChildItem -LiteralPath $Target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
$outBytes = (Get-Item -LiteralPath $OutFile).Length

$gz = "$OutFile.gz"
$src = [IO.File]::OpenRead($OutFile); $dst = [IO.File]::Create($gz)
$z = New-Object IO.Compression.GZipStream($dst, [IO.Compression.CompressionLevel]::Optimal)
$src.CopyTo($z); $z.Dispose(); $dst.Dispose(); $src.Dispose()
$gzBytes = (Get-Item -LiteralPath $gz).Length

[pscustomobject]@{
  target          = $Target
  exitCode        = $p.ExitCode
  seconds         = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  inputFiles      = $inFiles
  inputMB         = [math]::Round($inBytes / 1MB, 2)
  outputMB        = [math]::Round($outBytes / 1MB, 2)
  gzipMB          = [math]::Round($gzBytes / 1MB, 2)
  peakTreeRssMB   = [math]::Round($peak / 1MB, 0)
  peakTreeProcs   = $peakProcs
} | ConvertTo-Json
