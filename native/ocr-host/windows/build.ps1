param(
    [string]$Dotnet = 'dotnet',
    [ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64'
)
$ErrorActionPreference = 'Stop'
& $Dotnet publish "$PSScriptRoot/Rimefox.OcrHost.csproj" -c Release -r $Runtime -o "$PSScriptRoot/build" -p:DebugType=None -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) { throw 'OCR connector build failed' }
# Copy notices from the exact runtime pack selected by this build, not a guessed SDK version.
$assets = Get-Content -LiteralPath "$PSScriptRoot/obj/project.assets.json" -Raw | ConvertFrom-Json
$depsFile = Get-ChildItem -LiteralPath "$PSScriptRoot/bin/Release" -Recurse -Filter 'rimefox-ocr-host.deps.json' |
    Where-Object { $_.FullName -like "*\$Runtime\*" } | Select-Object -First 1
$deps = Get-Content -LiteralPath $depsFile.FullName -Raw | ConvertFrom-Json
$runtimeLibrary = $deps.libraries.PSObject.Properties.Name | Where-Object { $_ -like "runtimepack.Microsoft.NETCore.App.Runtime.$Runtime/*" } | Select-Object -First 1
if (!$runtimeLibrary) { throw 'Cannot identify the bundled .NET runtime for license packaging.' }
$runtimeVersion = ($runtimeLibrary -split '/')[-1]
$runtimePack = $null
foreach ($folder in $assets.packageFolders.PSObject.Properties.Name) {
    $candidate = Join-Path $folder "microsoft.netcore.app.runtime.$Runtime/$runtimeVersion"
    if (Test-Path -LiteralPath (Join-Path $candidate 'LICENSE.TXT')) { $runtimePack = $candidate; break }
}
if (!$runtimePack) { throw 'Cannot locate bundled runtime license files.' }
$dotnetRoot = Split-Path -Parent (Get-Command $Dotnet -CommandType Application).Source
$notices = Join-Path $PSScriptRoot 'build/licenses'
New-Item -ItemType Directory -Path $notices -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $dotnetRoot 'LICENSE.txt') -Destination (Join-Path $notices 'dotnet-library-license.txt') -Force
Copy-Item -LiteralPath (Join-Path $runtimePack 'LICENSE.TXT') -Destination (Join-Path $notices 'dotnet-MIT.txt') -Force
Copy-Item -LiteralPath (Join-Path $runtimePack 'THIRD-PARTY-NOTICES.TXT') -Destination (Join-Path $notices 'dotnet-third-party-notices.txt') -Force
Copy-Item -LiteralPath "$PSScriptRoot/licenses/CsWinRT-MIT.txt" -Destination $notices -Force
@{ runtime = $Runtime; dotnetRuntime = $runtimeVersion; windowsProjection = ($deps.libraries.PSObject.Properties.Name | Where-Object { $_ -like 'runtimepack.Microsoft.Windows.SDK.NET.Ref/*' }) } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $notices 'components.json') -Encoding UTF8
