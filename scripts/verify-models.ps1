param(
  [Parameter(Mandatory = $false)]
  [string]$Path = "."
)

$ErrorActionPreference = 'Stop'

$known = [ordered]@{
  '漫客_模型包_video_v1.2.0.7z' = 'a16577a9b5e9768a9a9105b995cc821517c8c80c95ca2852399a6ab8d6ed798e'
  '漫客_模型包_video_v1.1.0.7z' = '467140107e89a3a57cee3802d6938d1d702b28919b355aa399597e66b1e9ee9b'
  '漫客_模型包_image_v1.1.0.7z' = 'a7eaff5b4fee64a4d9712c6f2ffe0f3986476c882dd598ea45a4a57ded753a3b'
  '漫客_模型包_qwen_v1.1.0.7z'  = 'bc1278e031698ae6ad5375d9e4d580bdf3b932089a9e4c646109234205d4a42c'
  '漫客_模型包_voice_v1.1.0.7z' = '2396a902916cf9e0825819088b4c85039a15cd3785c12860f8ebf36b614d152c'
}

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Host "目录不存在: $Path" -ForegroundColor Red
  exit 2
}

$found = Get-ChildItem -LiteralPath $Path -Filter '*.7z' -File -ErrorAction SilentlyContinue
if (-not $found) {
  Write-Host "在 $Path 下没有找到 .7z 模型包" -ForegroundColor Yellow
  exit 2
}

$results = @()
$hasProblem = $false
foreach ($name in $known.Keys) {
  $file = $found | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
  if (-not $file) {
    $results += [pscustomobject]@{ 文件 = $name; 结果 = 'MISSING'; SHA256 = '' }
    if ($name -notmatch '_qwen_') { $hasProblem = $true }
    continue
  }
  Write-Host ("校验中: " + $file.Name + " ...")
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLower()
  if ($hash -eq $known[$name]) {
    $results += [pscustomobject]@{ 文件 = $name; 结果 = 'OK'; SHA256 = $hash }
  } else {
    $results += [pscustomobject]@{ 文件 = $name; 结果 = 'MISMATCH'; SHA256 = $hash }
    $hasProblem = $true
  }
}

# 额外文件提示
foreach ($file in $found) {
  if ($known.Keys -notcontains $file.Name) {
    $results += [pscustomobject]@{ 文件 = $file.Name; 结果 = 'UNKNOWN'; SHA256 = '' }
  }
}

$results | Format-Table -AutoSize

if ($hasProblem) {
  Write-Host "存在校验失败或缺失的必装包，请重新拷贝/下载后重试。" -ForegroundColor Red
  exit 1
}
Write-Host "全部模型包校验通过。" -ForegroundColor Green
exit 0
