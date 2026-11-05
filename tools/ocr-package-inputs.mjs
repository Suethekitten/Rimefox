import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// The component has an independent input identity. Extension download metadata is
// deliberately excluded, so pinning its ZIP hash cannot change that ZIP's identity.
export function componentProvenance(root, platform) {
  const paths = ['native/ocr-host/' + platform, 'native/ocr-host/INSTALL.md', 'LICENSE',
    'tools/package-ocr-preview.mjs', 'tools/ocr-package-inputs.mjs', 'lib/vendor/fflate.browser.mjs'];
  const git = args => {
    const result = spawnSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), ...args], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Cannot read component source identity');
    return result.stdout.trim();
  };
  const sourceCommit = git(['log', '-1', '--format=%H', '--', ...paths]);
  const files = git(['ls-files', '-z', '--', ...paths]).split('\0').filter(Boolean).sort();
  if (!sourceCommit || !files.length) throw new Error('Commit component inputs before packaging');
  const hash = createHash('sha256');
  for (const name of files) { hash.update(name + '\0'); hash.update(fs.readFileSync(path.join(root, name))); hash.update('\0'); }
  return { sourceCommit, sourceDigest: hash.digest('hex'), sourceFiles: files,
    dirtyWorktree: !!git(['status', '--porcelain']) };
}
