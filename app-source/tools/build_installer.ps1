param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [string]$Python = "python",
  [string]$Iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  [string]$Name = "漫客_安装程序_v2.10.79_rebuild"
)
$ErrorActionPreference = 'Stop'
& (Join-Path $Root 'tools\sync_source.ps1') -Root $Root -Python $Python
$runtime = Join-Path $Root 'runtime'
$dist = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$items = Get-ChildItem $runtime -Force | Where-Object { $_.Name -notin @('data','backends','unins000.dat','unins000.exe') } | Sort-Object Name
$lines = New-Object System.Text.StringBuilder
foreach ($it in $items) {
  if ($it.PSIsContainer) {
    [void]$lines.AppendLine('Source: "' + $it.FullName + '\*"; DestDir: "{app}\' + $it.Name + '"; Flags: ignoreversion recursesubdirs createallsubdirs')
  } else {
    [void]$lines.AppendLine('Source: "' + $it.FullName + '"; DestDir: "{app}"; Flags: ignoreversion')
  }
}
$template = Get-Content (Join-Path $Root 'installer\manke.iss.template') -Raw -Encoding UTF8
$text = $template.Replace('{{SOURCE}}', $runtime).Replace('{{OUTPUT}}', $dist).Replace('{{NAME}}', $Name).Replace('{{ICON}}', (Join-Path $Root 'installer\manke.ico')).Replace('{{FILES}}', $lines.ToString())
$iss = Join-Path $Root 'installer\build.iss'
Set-Content $iss $text -Encoding UTF8
& $Iscc $iss /Q
if ($LASTEXITCODE -ne 0) { throw "ISCC failed: $LASTEXITCODE" }
Write-Host "installer written to $dist\$Name.exe"
