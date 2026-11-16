param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [string]$Python = "python",
  [string]$SevenZip = "C:\Program Files\7-Zip\7z.exe",
  [string]$Name = "漫客_便携版_v2.10.79_rebuild"
)
$ErrorActionPreference = 'Stop'
& (Join-Path $Root 'tools\sync_source.ps1') -Root $Root -Python $Python
if (-not (Test-Path $SevenZip)) {
  $candidate = Join-Path $Root 'runtime\7z.exe'
  if (Test-Path $candidate) { $SevenZip = $candidate } else { throw '7z.exe not found' }
}
$runtime = Join-Path $Root 'runtime'
$dist = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$stage = Join-Path $Root '_portable_stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Get-ChildItem $runtime -Force | Where-Object { $_.Name -notin @('data','backends','unins000.dat','unins000.exe') } | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $stage $_.Name) -Recurse -Force
}
& $SevenZip a -t7z -mx=3 (Join-Path $dist ($Name + '.7z')) (Join-Path $stage '*') | Out-Null
Remove-Item $stage -Recurse -Force
Write-Host "portable written to $dist\$Name.7z"
