# 生成交接压缩包（Windows PowerShell）
# 用法：双击同目录的 package.bat，或在此目录执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\package.ps1
# 产物：同级目录下的 DualTrans-v<版本号>.zip
#       解压后得到 edge-bilingual/ 文件夹（manifest.json 在其根目录）

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
if (-not (Test-Path (Join-Path $src 'manifest.json'))) {
    throw "找不到 manifest.json，请在扩展根目录运行本脚本。"
}

$manifest = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version

$outDir = Split-Path $src -Parent
$zip = Join-Path $outDir ("DualTrans-v{0}.zip" -f $version)

if (Test-Path $zip) {
    Remove-Item $zip -Force
    Write-Host "已删除旧包: $zip"
}

# 用临时目录做 staging：保证 zip 里只有一层 edge-bilingual/
$staging = Join-Path $env:TEMP 'dualt-pkg'
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item -Path $src -Destination (Join-Path $staging 'edge-bilingual') -Recurse -Force

# 清理不该进包的文件：.git 是整个仓库历史（项目文件夹本身就是 git 仓库），其余是临时文件
Get-ChildItem -Path (Join-Path $staging 'edge-bilingual') -Recurse -Force -Include '.git', '.DS_Store', 'Thumbs.db', '*.log' |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 用 ZipFile 而不是 Compress-Archive：后者会漏掉 .gitignore 这类隐藏文件
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $staging,
    $zip,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)
Remove-Item $staging -Recurse -Force

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host ""
Write-Host "==============================================="
Write-Host " 已生成: $zip"
Write-Host " 版本  : $version"
Write-Host " 大小  : $size KB"
Write-Host "==============================================="
Write-Host ""
Write-Host "对方解压后：chrome://extensions/（Edge 为 edge://extensions/）-> 开发者模式 -> 加载已解压的扩展程序 -> 选 edge-bilingual 文件夹"
