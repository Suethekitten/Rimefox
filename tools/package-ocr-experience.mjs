// Assemble the Windows experience from audited, separately versioned archives.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from '../lib/vendor/fflate.browser.mjs';
import { componentProvenance } from './ocr-package-inputs.mjs';
import { OCR_COMPONENT_RELEASES, verifiedOcrRelease } from '../lib/ocr/feature.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).version;
const componentPath = path.resolve(option('--component', path.join(root, 'dist/ocr-preview/Rimefox-OCR-0.2.0-preview.1-windows-x64.zip')));
const componentName = path.basename(componentPath), extensionName = `Rimefox-v${version}.zip`;
const extensionPath = path.resolve(option('--extension', path.join(root, 'dist', extensionName)));
const output = path.resolve(option('--output', path.join(root, 'dist', 'release-' + version)));
const sha = data => createHash('sha256').update(data).digest('hex');
const component = fs.readFileSync(componentPath), checksum = fs.readFileSync(componentPath + '.sha256');
if (checksum.toString().trim() !== sha(component) + '  ' + componentName) throw new Error('Component ZIP checksum mismatch');
const entries = unzipSync(component), listed = new Set();
for (const line of new TextDecoder().decode(entries.SHA256SUMS).trim().split(/\r?\n/)) {
  const match = /^([a-f0-9]{64})  (.+)$/i.exec(line);
  if (!match || !entries[match[2]] || sha(entries[match[2]]) !== match[1].toLowerCase()) throw new Error('Invalid component file checksum');
  listed.add(match[2]);
}
if (Object.keys(entries).some(name => name !== 'SHA256SUMS' && !listed.has(name))) throw new Error('Unchecked component entry');
const preview = JSON.parse(new TextDecoder().decode(entries['preview.json']));
const provenance = componentProvenance(root, 'windows');
if (preview.platform !== 'windows' || preview.architecture !== 'x64' || preview.dirtyWorktree || provenance.dirtyWorktree
    || preview.sourceCommit !== provenance.sourceCommit || preview.sourceDigest !== provenance.sourceDigest) throw new Error('Component does not match the committed Windows inputs');
const release = verifiedOcrRelease(OCR_COMPONENT_RELEASES.windows);
if (!release || release.sha256 !== sha(component) || release.downloadBytes !== component.length
    || release.diskBytes !== Object.values(entries).reduce((sum, bytes) => sum + bytes.length, 0)
    || release.connector !== `https://github.com/Suethekitten/Rimefox/releases/download/v${version}/${componentName}`) throw new Error('Extension download metadata differs from the actual component');
const extension = fs.readFileSync(extensionPath);
const pack = spawnSync(process.execPath, [path.join(root, 'tools/package-store.mjs'), '--release'], { cwd: root, encoding: 'utf8' });
if (pack.status !== 0) throw new Error('Extension source packaging failed: ' + pack.stderr);
const expectedExtension = unzipSync(fs.readFileSync(path.join(root, 'dist', extensionName))), actualExtension = unzipSync(extension);
if (JSON.stringify(Object.keys(expectedExtension).sort()) !== JSON.stringify(Object.keys(actualExtension).sort())
    || Object.keys(expectedExtension).some(name => sha(expectedExtension[name]) !== sha(actualExtension[name]))) throw new Error('Extension asset differs from final source');
if (JSON.parse(new TextDecoder().decode(actualExtension['Rimefox/manifest.json'])).version !== version) throw new Error('Extension version mismatch');
const instructions = fs.readFileSync(path.join(root, 'native/ocr-host/INSTALL.md'), 'utf8')
  .replace('材料：OCR ZIP [绝对路径]', '材料（与本说明同目录）：OCR ZIP ' + componentName)
  .replace('ZIP SHA-256 文件 [绝对路径]', 'ZIP SHA-256 文件 ' + componentName + '.sha256')
  .replace('凛狐扩展安装包或可信安装入口 [路径或链接]', '凛狐扩展安装包 ' + extensionName);
const readme = `# 凛狐 ${version} Windows x64 系统 OCR 体验包\n\n` +
  `文件清单：\n\n- 扩展安装 ZIP：${extensionName}\n- 完整 OCR 组件 ZIP：${componentName}\n- 组件 ZIP 校验：${componentName}.sha256\n\n` +
  '请先按下文安装扩展，再读取自己浏览器中的实际扩展 ID 安装组件；Chrome / Edge ID 可能不同。提示词中的相对文件名均以本说明所在目录为基准。\n\n---\n\n' + instructions;
const files = { [extensionName]: extension, [componentName]: component, [componentName + '.sha256']: checksum, '安装说明.md': Buffer.from(readme) };
const archiveEntries = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, [new Uint8Array(bytes), { level: name.endsWith('.zip') ? 0 : 6, mtime: new Date(1980, 0, 1) }]]));
fs.mkdirSync(output, { recursive: true });
const filename = `Rimefox-v${version}-Windows-OCR-Preview.zip`, data = Buffer.from(zipSync(archiveEntries));
fs.writeFileSync(path.join(output, filename), data);
fs.writeFileSync(path.join(output, filename + '.sha256'), sha(data) + '  ' + filename + '\n');
const verified = unzipSync(data);
if (Object.keys(verified).length !== 4 || Object.entries(files).some(([name, bytes]) => sha(verified[name]) !== sha(bytes))) throw new Error('Experience ZIP verification failed');
fs.writeFileSync(path.join(output, 'experience-build.json'), JSON.stringify({ version, filename, sha256: sha(data), componentSHA256: sha(component), extensionSHA256: sha(extension), componentSource: provenance.sourceCommit, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])) }, null, 2));
console.log(path.join(output, filename)); console.log('SHA-256: ' + sha(data));
