# 由 icons/source.png 生成扩展图标（16/32/48/128/256）
# 用法（在仓库根目录或任意位置执行均可）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\make-icons.ps1
#
# 流程：自动找深色底板边界 -> 裁掉白边 -> 圆角蒙版 + 透明背景
#       -> 底图多画 5px 裁掉原图圆角的白色抗锯齿 -> 逐档缩放 -> 生成浅/深色预览
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'icons\source.png'
$out = Join-Path $root 'icons'

if (-not (Test-Path $src)) { throw "找不到源图：$src" }
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Force -Path $out | Out-Null }

$img = [System.Drawing.Image]::FromFile($src)

# ---- 1) 用 256px 缩略图找非白区域边界，再映射回原图 ----
$probe = New-Object System.Drawing.Bitmap 256, 256
$pg = [System.Drawing.Graphics]::FromImage($probe)
$pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$pg.DrawImage($img, 0, 0, 256, 256)
$pg.Dispose()

$x1 = 256; $y1 = 256; $x2 = -1; $y2 = -1
for ($y = 0; $y -lt 256; $y++) {
    for ($x = 0; $x -lt 256; $x++) {
        $c = $probe.GetPixel($x, $y)
        $lum = ($c.R + $c.G + $c.B) / 3.0
        if ($lum -lt 120) {
            if ($x -lt $x1) { $x1 = $x }
            if ($x -gt $x2) { $x2 = $x }
            if ($y -lt $y1) { $y1 = $y }
            if ($y -gt $y2) { $y2 = $y }
        }
    }
}
$probe.Dispose()
if ($x2 -lt 0) { throw '没有找到深色底板' }

$k = $img.Width / 256.0
$inset = 4
$side = [int](($x2 - $x1 + 1) * $k) - $inset * 2
$cropX = [int]($x1 * $k) + $inset
$cropY = [int]($y1 * $k) + $inset
$rect = New-Object System.Drawing.Rectangle $cropX, $cropY, $side, $side
Write-Host ("crop: {0}" -f $rect)

# ---- 2) 512 母版：圆角裁切 + 透明背景 ----
$size = 512
$radius = [int]($size * 0.20)
$master = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$mg = [System.Drawing.Graphics]::FromImage($master)
$mg.Clear([System.Drawing.Color]::Transparent)
$mg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$mg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$mg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d2 = $radius * 2
$path.AddArc(0, 0, $d2, $d2, 180, 90)
$path.AddArc($size - $d2, 0, $d2, $d2, 270, 90)
$path.AddArc($size - $d2, $size - $d2, $d2, $d2, 0, 90)
$path.AddArc(0, $size - $d2, $d2, $d2, 90, 90)
$path.CloseFigure()

$mg.SetClip($path)
$over = 5
$dest = New-Object System.Drawing.Rectangle (-$over), (-$over), ($size + $over * 2), ($size + $over * 2)
$mg.DrawImage($img, $dest, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$mg.Dispose()
$path.Dispose()
$master.Save((Join-Path $out 'icon512.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# ---- 3) 逐档缩放 ----
foreach ($s in 16, 32, 48, 128, 256) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($master, (New-Object System.Drawing.Rectangle 0, 0, $s, $s))
    $g.Dispose()
    $bmp.Save((Join-Path $out ('icon{0}.png' -f $s)), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("output icon{0}.png" -f $s)
}

# ---- 4) 预览：浅色 / 深色工具栏各一张（16px 放大 4 倍看清晰度） ----
function New-Preview {
    param([string]$OutFile, [System.Drawing.Color]$Bg)

    $bmp = New-Object System.Drawing.Bitmap 700, 280
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($Bg)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half

    $fg = [System.Drawing.Color]::FromArgb(200, 205, 212)
    if ($Bg.GetBrightness() -gt 0.5) { $fg = [System.Drawing.Color]::FromArgb(80, 80, 80) }
    $font = New-Object System.Drawing.Font 'Consolas', 12
    $brush = New-Object System.Drawing.SolidBrush $fg

    $i = [System.Drawing.Image]::FromFile((Join-Path $out 'icon128.png'))
    $g.DrawImage($i, 24, 96, 128, 128); $i.Dispose()
    $g.DrawString('128 native', $font, $brush, 24, 58)

    $i = [System.Drawing.Image]::FromFile((Join-Path $out 'icon16.png'))
    $g.DrawImage($i, 200, 160, 64, 64); $i.Dispose()
    $g.DrawString('16 x4', $font, $brush, 200, 58)

    $i = [System.Drawing.Image]::FromFile((Join-Path $out 'icon32.png'))
    $g.DrawImage($i, 320, 128, 128, 128); $i.Dispose()
    $g.DrawString('32 x4', $font, $brush, 320, 58)

    $i = [System.Drawing.Image]::FromFile((Join-Path $out 'icon48.png'))
    $g.DrawImage($i, 490, 96, 192, 192); $i.Dispose()
    $g.DrawString('48 x4', $font, $brush, 490, 58)

    $g.Dispose()
    $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("output {0}" -f (Split-Path $OutFile -Leaf))
}

New-Preview -OutFile (Join-Path $out 'preview-light.png') -Bg ([System.Drawing.Color]::FromArgb(255, 255, 255))
New-Preview -OutFile (Join-Path $out 'preview-dark.png') -Bg ([System.Drawing.Color]::FromArgb(18, 33, 46))

$img.Dispose()
$master.Dispose()
Write-Host 'done'
