param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Rimefox\OCR'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-common.ps1')
$directory = Get-InstallPath $InstallDirectory
$state = Get-InstallState $directory
if (!$state) { Write-Host 'No owned Rimefox OCR installation found. Nothing changed.'; return }
$manifest = Join-Path $directory 'com.rimefox.ocr.json'
foreach ($entry in $state.previousRegistrations) { Restore-Registration $entry $manifest }
# Only product-managed paths are removed. Unrelated files in the directory are left alone.
Remove-OwnedDirectory (Join-Path $directory 'versions') $directory
foreach ($file in @('com.rimefox.ocr.json', 'installation.json', 'install-common.ps1', 'uninstall.ps1')) {
    $path = Join-Path $directory $file
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
if (!(Get-ChildItem -LiteralPath $directory -Force)) { Remove-Item -LiteralPath $directory }
Write-Host 'Rimefox OCR removed. Existing browser registrations were restored where still owned. Browser extension and document library were not removed.'
