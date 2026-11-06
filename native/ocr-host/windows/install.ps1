param(
    [string[]]$ExtensionIds,
    [string]$PackageDirectory = $PSScriptRoot,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Rimefox\OCR'),
    [string]$RegistryPrefix = 'Software',
    [switch]$ReplaceExisting,
    [switch]$NoPrompt
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-common.ps1')
if (!$ExtensionIds -or !$ExtensionIds.Count) {
    if ($NoPrompt) { throw 'ExtensionIds is required.' }
    $ExtensionIds = @(Read-Host 'Paste the extension ID from Rimefox Settings > OCR (separate Chrome/Edge IDs with commas)')
}
$ids = @($ExtensionIds | ForEach-Object { $_ -split '[,;\s]+' } | Where-Object { $_ } | Sort-Object -Unique)
if (!$ids.Count -or @($ids | Where-Object { $_ -cnotmatch '^[a-p]{32}$' }).Count) { throw 'Each extension ID must contain exactly 32 lowercase letters a-p. No wildcards are allowed.' }
if ($RegistryPrefix -ne 'Software' -and $RegistryPrefix -notmatch '^Software\\Rimefox\\OCR\\InstallTests\\[A-Za-z0-9_-]+$') { throw 'Invalid test registry prefix.' }
$directory = Get-InstallPath $InstallDirectory
$state = Get-InstallState $directory
if (!$state -and (Test-Path -LiteralPath $directory) -and @(Get-ChildItem -LiteralPath $directory -Force).Count) { throw 'Destination is not an owned Rimefox OCR installation. Choose an empty directory.' }
if ($state -and $state.registryPrefix -ne $RegistryPrefix) { throw 'Registry prefix differs from the existing installation.' }
$manifest = Join-Path $directory 'com.rimefox.ocr.json'
$registrations = @()
foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
    $key = "$RegistryPrefix\$browser\NativeMessagingHosts\com.rimefox.ocr"
    $current = Get-Registration $key
    if ($current.present -and $current.value -ne $manifest -and !$ReplaceExisting) { throw "Another host is registered at HKCU\$key. Review it first; -ReplaceExisting explicitly allows replacement and backup." }
    $registrations += $current
}
if ($state) {
    $registrations = @($registrations | ForEach-Object {
        $currentEntry = $_
        if ($currentEntry.present -and $currentEntry.value -ne $manifest) { $currentEntry }
        else {
            $originalEntry = @($state.previousRegistrations | Where-Object { $_.key -eq $currentEntry.key }) | Select-Object -First 1
            if ($originalEntry) { $originalEntry } else { $currentEntry }
        }
    })
}
$source = Join-Path $PackageDirectory 'rimefox-ocr-host.exe'
$checksums = Join-Path $PackageDirectory 'SHA256SUMS'
if (!(Test-Path -LiteralPath $checksums)) { throw 'SHA256SUMS is missing. Use a complete preview package.' }
$line = [IO.File]::ReadAllLines($checksums) | Where-Object { $_ -match '^[a-fA-F0-9]{64}  rimefox-ocr-host\.exe$' } | Select-Object -First 1
if (!$line) { throw 'No connector checksum in SHA256SUMS.' }
$expected = $line.Substring(0, 64).ToLowerInvariant()
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SHA-256 mismatch. Nothing was installed.' }
# Versioned executable paths allow upgrade while an older browser host is still running.
$versionDirectory = Join-Path $directory ('versions\' + $expected)
$versionDirectory = Get-InstallPath $versionDirectory
$binary = Join-Path $versionDirectory 'rimefox-ocr-host.exe'
$staging = Join-Path ([IO.Path]::GetTempPath()) ('rimefox-ocr-install-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($staging) | Out-Null
try {
    $staged = Join-Path $staging 'rimefox-ocr-host.exe'
    Copy-Item -LiteralPath $source -Destination $staged
    $diagnostic = & $staged --diagnose
    if ($LASTEXITCODE -ne 0) { throw 'Connector could not start. Review Windows security messages; no system protection is changed by this installer.' }
    $capability = ($diagnostic -join "`n") | ConvertFrom-Json
    [IO.Directory]::CreateDirectory($versionDirectory) | Out-Null
    if (!(Test-Path -LiteralPath $binary)) { Copy-Item -LiteralPath $staged -Destination $binary }
    elseif ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Existing connector has been modified; close browsers and repair the installation.' }
    $licenseSource = Join-Path $PackageDirectory 'licenses'
    if (Test-Path -LiteralPath $licenseSource) {
        $licenseTarget = Get-InstallPath (Join-Path $versionDirectory 'licenses')
        [IO.Directory]::CreateDirectory($licenseTarget) | Out-Null
        Get-ChildItem -LiteralPath $licenseSource -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Get-InstallPath (Join-Path $licenseTarget $_.Name)) -Force }
    }
    $next = @{ schema = 1; product = $ProductId; directory = $directory; registryPrefix = $RegistryPrefix; previousRegistrations = $registrations; sha256 = $expected; extensionIds = $ids }
    foreach ($script in @('uninstall.ps1', 'install-common.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $directory $script) -Force }
    $hostManifest = @{ name = $ProductId; description = 'Rimefox system OCR preview'; type = 'stdio'; path = $binary; allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" }) }
    # Save ownership/backup before changing the registrations. A subsequent uninstall can recover a partial install.
    Write-JsonFile (Join-Path $directory 'installation.json') $next
    Write-JsonFile $manifest $hostManifest
    foreach ($entry in $registrations) { Set-Registration $entry.key $manifest }
    # Post-install self-check (0.17.2): in a terminal that redirects writes, roll back and fail instead of reporting success.
    $localAppData = if ($env:RIMEFOX_OCR_TEST_LOCALAPPDATA) { $env:RIMEFOX_OCR_TEST_LOCALAPPDATA } else { $env:LOCALAPPDATA }
    $redirected = Find-RedirectedInstall $directory $localAppData $expected
    if ($redirected) {
        & (Join-Path $directory 'uninstall.ps1') -InstallDirectory $directory | Out-Null
        throw ("This terminal redirects writes into an app's private folder ($redirected), so your browser cannot see the component. " +
            'The installation was rolled back. Open Windows PowerShell from the Start menu (not a terminal inside another app) and run install.ps1 again with the same extension IDs.')
    }
    Write-Host "Installed current-user OCR preview: $binary"
    Write-Host ('OCR languages: ' + ($capability.languages -join ', '))
    if ($capability.apiStatus -ne 'ready') { Write-Warning 'Windows OCR is not available in this environment. Keep the preview disabled and report --diagnose output.' }
    if (!@($capability.languages | Where-Object { $_ -match '^zh(?:-|$)' }).Count) {
        Write-Warning 'Chinese OCR is not installed. Open Settings > Time & language > Language & region, add Chinese and its OCR language feature. Installation may require your administrator. This installer does not elevate or install Windows components.'
    }
    Write-Host 'Unsigned preview: Windows security or organization policy may block this executable. No certificate, Gatekeeper-like policy or SmartScreen setting is changed.'
    Write-Host 'Return to Rimefox Settings > OCR, grant the local-component permission and click Recheck.'
} finally {
    # Staging is a freshly created, fixed-prefix temporary directory; verify before recursive cleanup.
    if ([IO.Path]::GetFullPath($staging).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $staging -Leaf) -like 'rimefox-ocr-install-*') {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
