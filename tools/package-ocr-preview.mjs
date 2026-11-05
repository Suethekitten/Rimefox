// Local-only preview packaging. Never publishes, uploads or invents a download URL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { zipSync } from '../lib/vendor/fflate.browser.mjs';
import { componentProvenance } from './ocr-package-inputs.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const platform = option('--platform', process.platform === 'darwin' ? 'macos' : 'windows');
if (!['macos', 'windows'].includes(platform)) throw new Error('Use --platform windows|macos');
if ((platform === 'macos') !== (process.platform === 'darwin') || (platform === 'windows' && process.platform !== 'win32'))
  throw new Error('Package on the target OS so the real connector and its diagnostics can be verified.');
const directory = path.join(root, 'native/ocr-host', platform);
const filename = platform === 'windows' ? 'rimefox-ocr-host.exe' : 'rimefox-ocr-host';
const binary = path.resolve(option('--binary', path.join(directory, 'build', filename)));
const versionCheck = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
if (versionCheck.status !== 0) throw new Error('Build a working connector first: ' + (versionCheck.stderr || versionCheck.error));
const version = /rimefox-ocr-host ([0-9A-Za-z.-]+) \(protocol 1\)/.exec(versionCheck.stdout)?.[1];
if (!version) throw new Error('Invalid connector version output');
const diagnostic = spawnSync(binary, ['--diagnose'], { encoding: 'utf8', windowsHide: true });
if (diagnostic.status !== 0) throw new Error('Connector diagnostics failed');
const capability = JSON.parse(diagnostic.stdout);
const provenance = componentProvenance(root, platform);
if (provenance.dirtyWorktree) throw new Error('Commit and review all source changes before packaging a distributable component.');
const architecture = platform === 'macos' ? 'universal' : capability.architecture.toLowerCase();
let deploymentTargets = [];
if (platform === 'macos') {
  if (spawnSync('lipo', ['-verify_arch', 'arm64', 'x86_64', binary]).status !== 0)
    throw new Error('macOS preview must contain Apple Silicon and Intel slices');
  const details = spawnSync('otool', ['-l', binary], { encoding: 'utf8' });
  deploymentTargets = [...(details.stdout || '').matchAll(/cmd LC_BUILD_VERSION[\s\S]*?minos (\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1]);
  if (details.status !== 0 || deploymentTargets.length !== 2 || deploymentTargets.some(target => !/^12\.0(?:\.0)?$/.test(target)))
    throw new Error('Both Mach-O slices must target macOS 12.0; inspect otool -l output before packaging.');
}
const output = path.resolve(option('--output', path.join(root, 'dist/ocr-preview')));
fs.mkdirSync(output, { recursive: true });
const files = { [filename]: fs.readFileSync(binary) };
for (const name of platform === 'windows' ? ['install.ps1', 'install-common.ps1', 'uninstall.ps1'] : ['install.sh', 'uninstall.sh'])
  files[name] = fs.readFileSync(path.join(directory, name));
files['INSTALL.md'] = fs.readFileSync(path.join(root, 'native/ocr-host/INSTALL.md'));
files.LICENSE = fs.readFileSync(path.join(root, 'LICENSE'));
if (platform === 'windows') {
  const notices = path.join(path.dirname(binary), 'licenses');
  for (const name of ['dotnet-library-license.txt', 'dotnet-MIT.txt', 'dotnet-third-party-notices.txt', 'CsWinRT-MIT.txt', 'components.json'])
    files['licenses/' + name] = fs.readFileSync(path.join(notices, name));
  files['THIRD-PARTY-NOTICES.md'] = fs.readFileSync(path.join(directory, 'THIRD-PARTY-NOTICES.md'));
}
files['preview.json'] = Buffer.from(JSON.stringify({ product: 'com.rimefox.ocr', version, platform, architecture,
  channel: 'system-ocr-preview', publisherSignature: 'not-verified', notarization: 'not-verified', deploymentTargets,
  compatibility: platform === 'windows' ? 'Unpackaged API compatibility is not guaranteed across Windows environments.' : 'macOS 12+ deployment target; real downloaded/quarantined installation still needs manual acceptance.',
  ...provenance,
  buildMachineDiagnostic: capability }, null, 2));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
files.SHA256SUMS = Buffer.from(Object.entries(files).map(([name, bytes]) => sha(bytes) + '  ' + name).join('\n') + '\n');
const zipFiles = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, [new Uint8Array(bytes), { mtime: new Date(1980, 0, 1), attrs: name.endsWith('.sh') || name === 'rimefox-ocr-host' ? 0o100755 << 16 : 0o100644 << 16 }]]));
const archive = path.join(output, `Rimefox-OCR-${version}-${platform}-${architecture}.zip`);
const data = Buffer.from(zipSync(zipFiles, { level: 6 }));
fs.writeFileSync(archive, data);
fs.writeFileSync(archive + '.sha256', sha(data) + '  ' + path.basename(archive) + '\n');
console.log(archive);
console.log('SHA-256: ' + sha(data));
console.log('Local preview only; no Release was created and nothing was uploaded.');
