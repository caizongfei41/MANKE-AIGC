param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [string]$Python = "python"
)
$ErrorActionPreference = 'Stop'
$src = Join-Path $Root 'src\asar\bundle'
$dst = Join-Path $Root 'runtime\resources\app.asar.unpacked\bundle'
if (-not (Test-Path $src)) { throw "missing source bundle: $src" }
robocopy $src $dst /MIR /R:1 /W:1 /NFL /NDL /NP | Out-Null
& $Python (Join-Path $Root 'tools\sync_asar.py') (Join-Path $Root 'runtime')
if ($LASTEXITCODE -ne 0) { throw 'sync_asar failed' }
Write-Host 'source bundle synced to runtime'
