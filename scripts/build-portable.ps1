param(
  [Parameter(Mandatory = $true)]
  [string]$Source,
  [Parameter(Mandatory = $false)]
  [string]$Output = ".\漫客_便携版_v2.10.79.7z",
  [Parameter(Mandatory = $false)]
  [string]$SevenZip = "7z.exe"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source)) {
  throw "源目录不存在: $Source"
}
if (-not (Test-Path -LiteralPath $SevenZip)) {
  $cmd = Get-Command $SevenZip -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "找不到 7z.exe，请用 -SevenZip 指定完整路径" }
  $SevenZip = $cmd.Source
}

$sourceFull = (Resolve-Path -LiteralPath $Source).Path
$stage = Join-Path $env:TEMP ("manke_portable_" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
  Write-Host "暂存程序文件（排除 data / backends / 卸载器）..."
  robocopy $sourceFull $stage /E /XD (Join-Path $sourceFull 'data') (Join-Path $sourceFull 'backends') `
    /XF 'unins000.dat' 'unins000.exe' /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，exit=$LASTEXITCODE" }

  $readme = @"
漫客 便携版（已激活）
========================
1) 解压到任意目录，双击 Manke.exe 运行。
2) 数据保存在程序目录 data\。
3) 模型包不包含在压缩包内：解压后用 set-models-dir.bat 指向模型目录。
4) 不写注册表、无需安装；卸载 = 删除整个文件夹。
5) 重新激活：删除 data\password-ok 后启动，输入密码。
"@
  [IO.File]::WriteAllText((Join-Path $stage '便携版说明.txt'), $readme, (New-Object Text.UTF8Encoding($true)))

  if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output -Force }
  Push-Location $stage
  try {
    & $SevenZip a -t7z -mx=9 -mmt=on -ms=on $Output * | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7z 压缩失败，exit=$LASTEXITCODE" }
  } finally { Pop-Location }

  $item = Get-Item -LiteralPath $Output
  Write-Host ("完成: " + $item.FullName + "  " + [math]::Round($item.Length / 1MB, 1) + " MB")
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
