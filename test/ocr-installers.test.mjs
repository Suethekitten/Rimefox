// Opt-in OS integration: real connector, isolated current-user registrations / synthetic Mac home.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { unzipSync } from '../lib/vendor/fflate.browser.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.platform === 'win32' ? 'windows' : 'macos';
const binaryName = platform === 'windows' ? 'rimefox-ocr-host.exe' : 'rimefox-ocr-host';
const directory = path.join(root, 'native/ocr-host', platform);
const enabled = process.env.RIMEFOX_TEST_INSTALLERS === '1' && ['win32', 'darwin'].includes(process.platform);
const binary = path.join(directory, 'build', binaryName);
const previewZip = process.env.RIMEFOX_OCR_PREVIEW_ZIP;
if (enabled && !previewZip && !fs.existsSync(binary)) throw new Error('Build the connector before explicitly requesting installer tests');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 45000, windowsHide: true });
  return { ...result, output: (result.stdout || '') + (result.stderr || '') };
}
function succeeded(result) { assert.equal(result.status, 0, result.output || result.error?.message); return result; }
function removeTemporary(work) {
  const full = fs.realpathSync(work), base = fs.realpathSync(os.tmpdir()) + path.sep;
  assert.ok(full.startsWith(base) && path.basename(full).startsWith('rimefox-install-test-'));
  fs.rmSync(full, { recursive: true, force: true });
}
test('system OCR preview installer: checksum, IDs, spaces, reinstall/upgrade, restore and ownership-safe uninstall', {
  skip: enabled ? false : 'Set RIMEFOX_TEST_INSTALLERS=1 to run OS integration', timeout: 180000
}, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-install-test-'));
  const pkg = path.join(work, 'Package with spaces'); fs.mkdirSync(pkg);
  const source = path.join(pkg, binaryName);
  if (previewZip) {
    assert.equal(sha(previewZip), fs.readFileSync(previewZip + '.sha256', 'utf8').slice(0, 64), 'ZIP SHA-256 differs from its trusted test input');
    const entries = unzipSync(fs.readFileSync(previewZip));
    for (const [name, bytes] of Object.entries(entries)) {
      const target = path.resolve(pkg, name);
      assert.ok(target.startsWith(pkg + path.sep) && !name.includes('..') && !name.includes('\\'), 'unsafe archive path');
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
    }
    for (const line of fs.readFileSync(path.join(pkg, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})  (.+)$/i.exec(line); assert.ok(match);
      assert.ok(entries[match[2]], 'checksum references a missing entry');
      assert.equal(createHash('sha256').update(entries[match[2]]).digest('hex'), match[1].toLowerCase());
    }
  } else {
    fs.copyFileSync(binary, source);
    if (platform === 'windows') fs.cpSync(path.join(path.dirname(binary), 'licenses'), path.join(pkg, 'licenses'), { recursive: true });
    for (const script of platform === 'windows' ? ['install.ps1', 'install-common.ps1', 'uninstall.ps1'] : ['install.sh', 'uninstall.sh'])
      fs.copyFileSync(path.join(directory, script), path.join(pkg, script));
  }
  fs.chmodSync(source, 0o755);
  const updateHash = () => fs.writeFileSync(path.join(pkg, 'SHA256SUMS'), sha(source) + '  ' + binaryName + '\n');
  updateHash();
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const install = path.join(work, 'Installed OCR with spaces 中文');
  const prefix = 'Software\\Rimefox\\OCR\\InstallTests\\' + randomUUID();
  const registry = (action, value = '') => run('powershell.exe', ['-NoProfile', '-Command', `
    $prefix=$env:RIMEFOX_INSTALL_TEST_PREFIX
    if ($prefix -notmatch '^Software\\\\Rimefox\\\\OCR\\\\InstallTests\\\\[a-f0-9-]+$') { throw 'Unsafe test prefix' }
    if ($env:RIMEFOX_INSTALL_TEST_ACTION -eq 'clear') { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($prefix,$false); exit }
    $key=$prefix+'\\Google\\Chrome\\NativeMessagingHosts\\com.rimefox.ocr'
    if ($env:RIMEFOX_INSTALL_TEST_ACTION -eq 'set') { $r=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($key);$r.SetValue('',$env:RIMEFOX_INSTALL_TEST_VALUE);$r.Dispose();exit }
    $r=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key)
    if ($r) { $value=$r.GetValue('');$r.Dispose();ConvertTo-Json -InputObject $value -Compress } else { 'null' }
  `], { ...process.env, RIMEFOX_INSTALL_TEST_PREFIX: prefix, RIMEFOX_INSTALL_TEST_ACTION: action, RIMEFOX_INSTALL_TEST_VALUE: value });
  const macHomeInput = path.join(work, 'Home with spaces 中文'); fs.mkdirSync(macHomeInput);
  const macHome = fs.realpathSync(macHomeInput);
  const macEnv = { ...process.env, RIMEFOX_OCR_TEST_HOME: macHome };
  const destination = platform === 'windows' ? install : path.join(macHome, 'Library/Application Support/Rimefox/OCR');
  const chromeManifest = platform === 'windows' ? null : path.join(macHome, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.rimefox.ocr.json');
  const previous = platform === 'windows' ? path.join(work, 'Other host manifest.json') : JSON.stringify({ name: 'com.rimefox.ocr', path: '/another/host', type: 'stdio', allowed_origins: [] });
  const perform = (ids, replace = false) => platform === 'windows'
    ? run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(pkg, 'install.ps1'), '-PackageDirectory', pkg,
      '-ExtensionIds', ids, '-InstallDirectory', destination, '-RegistryPrefix', prefix, '-NoPrompt', ...(replace ? ['-ReplaceExisting'] : [])])
    : run('/bin/sh', [path.join(pkg, 'install.sh'), '--extension-id', ids, ...(replace ? ['--replace-existing'] : [])], macEnv);
  const uninstall = () => platform === 'windows'
    ? run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(pkg, 'uninstall.ps1'), '-InstallDirectory', destination])
    : run('/bin/sh', [path.join(pkg, 'uninstall.sh')], macEnv);
  try {
    if (platform === 'windows') succeeded(registry('set', previous));
    else { fs.mkdirSync(path.dirname(chromeManifest), { recursive: true }); fs.writeFileSync(chromeManifest, previous); }
    assert.notEqual(perform('*').status, 0, 'wildcard IDs must be rejected');
    assert.notEqual(perform(a).status, 0, 'foreign registrations must require explicit replacement');
    fs.writeFileSync(path.join(pkg, 'SHA256SUMS'), '0'.repeat(64) + '  ' + binaryName + '\n');
    assert.notEqual(perform(a, true).status, 0, 'bad checksum must be rejected before installation');
    assert.equal(fs.existsSync(destination), false);
    updateHash();
    succeeded(perform(a + ',' + b + ',' + a, true));
    const manifestPath = platform === 'windows' ? path.join(destination, 'com.rimefox.ocr.json') : chromeManifest;
    const first = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(first.allowed_origins.sort(), [a, b].map(id => 'chrome-extension://' + id + '/'));
    assert.ok(fs.existsSync(first.path), 'Manifest executable is missing: ' + first.path);
    // Windows PowerShell expands an 8.3 TEMP path (RUNNER~1 on CI); compare
    // canonical filesystem paths while still rejecting any executable outside the install.
    const relativeBinary = path.relative(fs.realpathSync.native(destination), fs.realpathSync.native(first.path));
    assert.ok(relativeBinary && !path.isAbsolute(relativeBinary) && relativeBinary !== '..' && !relativeBinary.startsWith('..' + path.sep),
      'Manifest executable is outside the installation: ' + JSON.stringify({ destination, executable: first.path }));
    if (platform === 'windows') assert.ok(fs.existsSync(path.join(path.dirname(first.path), 'licenses/dotnet-library-license.txt')));
    const diagnostic = JSON.parse(succeeded(run(first.path, ['--diagnose'])).stdout);
    assert.equal(diagnostic.protocol, 1); assert.ok(Array.isArray(diagnostic.languages));
    succeeded(perform(b));
    const repeated = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(repeated.allowed_origins, ['chrome-extension://' + b + '/']);
    if (platform === 'windows') {
      // .NET apphost locates its bundle by a stored offset; an inert overlay represents a different rebuilt binary.
      fs.appendFileSync(source, Buffer.from('Rimefox installer upgrade fixture'));
      updateHash(); succeeded(perform(a));
      const upgraded = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.notEqual(upgraded.path, first.path);
      assert.equal(fs.readdirSync(path.join(destination, 'versions')).length, 2);
      assert.equal(JSON.parse(succeeded(run(upgraded.path, ['--diagnose'])).stdout).protocol, 1);
    }
    fs.writeFileSync(path.join(destination, 'unrelated.txt'), 'keep me');
    succeeded(uninstall());
    assert.equal(fs.readFileSync(path.join(destination, 'unrelated.txt'), 'utf8'), 'keep me');
    assert.equal(fs.existsSync(path.join(destination, 'versions')), false);
    if (platform === 'windows') assert.equal(JSON.parse(succeeded(registry('read')).stdout), previous);
    else assert.equal(fs.readFileSync(chromeManifest, 'utf8'), previous);
    succeeded(uninstall());
    fs.unlinkSync(path.join(destination, 'unrelated.txt'));
    succeeded(perform(a, true));
    const laterHost = platform === 'windows' ? path.join(work, 'Later host.json') : JSON.stringify({ name: 'com.rimefox.ocr', path: '/later/host', type: 'stdio', allowed_origins: [] });
    if (platform === 'windows') succeeded(registry('set', laterHost)); else fs.writeFileSync(chromeManifest, laterHost);
    assert.notEqual(perform(b).status, 0, 'upgrades must not silently replace a later external registration');
    succeeded(perform(b, true));
    succeeded(uninstall());
    if (platform === 'windows') assert.equal(JSON.parse(succeeded(registry('read')).stdout), laterHost);
    else assert.equal(fs.readFileSync(chromeManifest, 'utf8'), laterHost);
    // A component installed by another program after us must also survive uninstall.
    succeeded(perform(a, true));
    if (platform === 'windows') succeeded(registry('set', previous)); else fs.writeFileSync(chromeManifest, previous);
    succeeded(uninstall());
    if (platform === 'windows') assert.equal(JSON.parse(succeeded(registry('read')).stdout), previous);
    else assert.equal(fs.readFileSync(chromeManifest, 'utf8'), previous);
    console.log('Installer integration passed: ' + platform + ', runtime=' + diagnostic.apiStatus + ', languages=' + diagnostic.languages.join(','));
  } finally {
    try { uninstall(); } finally { if (platform === 'windows') succeeded(registry('clear')); removeTemporary(work); }
  }
});

// 0.17.2：在会重定向写入的终端（MSIX 打包的桌面应用）里安装时，安装器自检到 Packages\*\LocalCache\Local 下的副本，
// 撤销安装并失败。用 RIMEFOX_OCR_TEST_LOCALAPPDATA 指向临时目录，预置一份「重定向副本」模拟该视图。
test('Windows installer: a redirected install is detected, rolled back and reported as a failure', {
  skip: enabled && platform === 'windows' ? false : 'Windows installer integration only (RIMEFOX_TEST_INSTALLERS=1)', timeout: 120000
}, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-install-test-'));
  const pkg = path.join(work, 'pkg'); fs.mkdirSync(pkg);
  const source = path.join(pkg, binaryName);
  fs.copyFileSync(binary, source);
  fs.cpSync(path.join(path.dirname(binary), 'licenses'), path.join(pkg, 'licenses'), { recursive: true });
  for (const script of ['install.ps1', 'install-common.ps1', 'uninstall.ps1']) fs.copyFileSync(path.join(directory, script), path.join(pkg, script));
  const digest = sha(source);
  fs.writeFileSync(path.join(pkg, 'SHA256SUMS'), digest + '  ' + binaryName + '\n');
  const local = path.join(work, 'Local');
  const destination = path.join(local, 'Rimefox', 'OCR');
  const redirectedCopy = path.join(local, 'Packages', 'Fake.DesktopApp_test', 'LocalCache', 'Local', 'Rimefox', 'OCR');
  fs.mkdirSync(redirectedCopy, { recursive: true });
  fs.writeFileSync(path.join(redirectedCopy, 'installation.json'), JSON.stringify({ product: 'com.rimefox.ocr', sha256: digest }));
  const prefix = 'Software\\Rimefox\\OCR\\InstallTests\\' + randomUUID();
  const env = { ...process.env, RIMEFOX_OCR_TEST_LOCALAPPDATA: local };
  try {
    const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(pkg, 'install.ps1'), '-PackageDirectory', pkg,
      '-ExtensionIds', 'a'.repeat(32), '-InstallDirectory', destination, '-RegistryPrefix', prefix, '-NoPrompt'], env);
    assert.notEqual(result.status, 0, 'a redirected install must not report success: ' + result.output);
    assert.match(result.output, /redirects writes/);
    assert.equal(fs.existsSync(path.join(destination, 'installation.json')), false, 'the redirected install is rolled back');
    const reg = run('powershell.exe', ['-NoProfile', '-Command',
      `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${prefix}\\Google\\Chrome\\NativeMessagingHosts\\com.rimefox.ocr'); if ($k) { 'present' } else { 'absent' }`]);
    assert.match(reg.stdout, /absent/, 'browser registration is restored');
    // Without the redirected copy the same command succeeds.
    fs.rmSync(path.join(local, 'Packages'), { recursive: true, force: true });
    succeeded(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(pkg, 'install.ps1'), '-PackageDirectory', pkg,
      '-ExtensionIds', 'a'.repeat(32), '-InstallDirectory', destination, '-RegistryPrefix', prefix, '-NoPrompt'], env));
    succeeded(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(destination, 'uninstall.ps1'), '-InstallDirectory', destination]));
  } finally {
    run('powershell.exe', ['-NoProfile', '-Command', `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${prefix}', $false)`]);
    removeTemporary(work);
  }
});
