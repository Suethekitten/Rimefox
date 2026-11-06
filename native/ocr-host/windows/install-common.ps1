# Shared, current-user-only installer operations. Compatible with Windows PowerShell 5.1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
$ProductId = 'com.rimefox.ocr'
function Write-JsonFile($Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
}
function Get-InstallPath([string]$Directory) {
    $full = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\') -or $full.Length -lt 12) { throw 'Unsafe installation directory.' }
    $probe = $full
    while ($probe) {
        if ((Test-Path -LiteralPath $probe) -and ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation paths must not contain junctions or symbolic links.' }
        $parent = [IO.Path]::GetDirectoryName($probe)
        if (!$parent -or $parent -eq $probe) { break }; $probe = $parent
    }
    return $full
}
function Get-InstallState([string]$Directory) {
    $file = Join-Path $Directory 'installation.json'
    if (!(Test-Path -LiteralPath $file)) { return $null }
    $state = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if ($state.product -ne $ProductId -or $state.schema -ne 1 -or $state.directory -ne $Directory) { throw 'Installation ownership marker is invalid.' }
    return $state
}
function Get-Registration([string]$Key) {
    $item = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key)
    if (!$item) { return @{ key = $Key; present = $false; value = $null; kind = 'String' } }
    try {
        $exists = @($item.GetValueNames()) -contains ''
        if (!$exists) { return @{ key = $Key; present = $false; value = $null; kind = 'String' } }
        $kind = $item.GetValueKind('').ToString()
        if ($kind -notin @('String', 'ExpandString')) { throw "Unsupported existing registry type at HKCU\$Key" }
        return @{ key = $Key; present = $true; value = $item.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); kind = $kind }
    } finally { $item.Dispose() }
}
function Set-Registration([string]$Key, [string]$Value, [string]$Kind = 'String') {
    $item = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Key)
    try { $item.SetValue('', $Value, [Microsoft.Win32.RegistryValueKind]::$Kind) } finally { $item.Dispose() }
}
function Restore-Registration($Previous, [string]$OwnedManifest) {
    $current = Get-Registration $Previous.key
    if (!$current.present -or $current.value -ne $OwnedManifest) { return } # Never remove another application's registration.
    if ($Previous.present) { Set-Registration $Previous.key $Previous.value $Previous.kind; return }
    $item = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Previous.key, $true)
    if (!$item) { return }
    try { $item.DeleteValue('', $false); $empty = $item.ValueCount -eq 0 -and $item.SubKeyCount -eq 0 } finally { $item.Dispose() }
    if ($empty) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($Previous.key, $false) }
}
function Remove-OwnedDirectory([string]$Directory, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $base = Get-InstallPath $Root
    if (!$full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove a path outside the installation.' }
    if (Test-Path -LiteralPath $full) {
        if ((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to remove a reparse point.' }
        if (Get-ChildItem -LiteralPath $full -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Refusing to remove a directory containing reparse points.' }
        Remove-Item -LiteralPath $full -Recurse -Force
    }
}
# MSIX / Store-packaged desktop apps (seen with the Claude desktop app, 2026-11) can redirect their built-in
# terminal's writes under %LOCALAPPDATA% to %LOCALAPPDATA%\Packages\<app>\LocalCache\Local, where the user's own
# browser never looks. The same process sees both the virtual path and the real Packages path: if the
# installation.json just written (same product and connector SHA-256) also exists under a
# Packages\*\LocalCache\Local folder, this install was redirected. Returns that copy's path, otherwise $null.
function Find-RedirectedInstall([string]$Directory, [string]$LocalAppData, [string]$Sha256) {
    if (!$LocalAppData) { return $null }
    $base = [IO.Path]::GetFullPath($LocalAppData).TrimEnd('\')
    if (!$Directory.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $relative = $Directory.Substring($base.Length + 1)
    $packages = Join-Path $base 'Packages'
    if (!(Test-Path -LiteralPath $packages)) { return $null }
    foreach ($app in @(Get-ChildItem -LiteralPath $packages -Directory -Force -ErrorAction SilentlyContinue)) {
        $candidate = Join-Path $app.FullName ('LocalCache\Local\' + $relative + '\installation.json')
        if (!(Test-Path -LiteralPath $candidate)) { continue }
        try { $copy = [IO.File]::ReadAllText($candidate) | ConvertFrom-Json } catch { continue }
        if ($copy.PSObject.Properties['product'] -and $copy.PSObject.Properties['sha256'] -and
            $copy.product -eq $ProductId -and $copy.sha256 -eq $Sha256) { return $candidate }
    }
    return $null
}
