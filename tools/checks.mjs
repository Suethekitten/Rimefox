// Cross-platform entry point: no shell globs, no paid API, no user profile.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
function run(args, executable = process.execPath, env = process.env) {
  const result = spawnSync(executable, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (process.argv[2] === 'unit') {
  const version = JSON.parse(fs.readFileSync('manifest.json')).version;
  if (version !== JSON.parse(fs.readFileSync('package.json')).version || !fs.readFileSync('content/core.js', 'utf8').includes("DT.VERSION = '" + version + "'")) throw new Error('Version mismatch');
  // GitHub's Windows runner may pipe Python output through a legacy code page.
  run(['-X', 'utf8', 'tools/check-release-notes.py', version], process.platform === 'win32' ? 'python' : 'python3', { ...process.env, PYTHONIOENCODING: 'utf-8' });
  run(['--test', ...fs.readdirSync('test').filter((f) => f.endsWith('.test.mjs')).map((f) => 'test/' + f)]);
} else if (process.argv[2] === 'browser') {
  const edge = process.env.RIMEFOX_TEST_BROWSER === 'edge';
  const candidates = process.platform === 'darwin'
    ? [edge ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map((p) => path.join(p, edge ? 'Microsoft/Edge/Application/msedge.exe' : 'Google/Chrome/Application/chrome.exe'))
      : [edge ? '/usr/bin/microsoft-edge' : '/usr/bin/google-chrome'];
  const browser = process.env.RIMEFOX_BROWSER || candidates.find((p) => fs.existsSync(p));
  if (!browser) throw new Error('Requested browser is not installed: ' + (edge ? 'Edge' : 'Chrome'));
  process.env.RIMEFOX_BROWSER = browser;
  run(['tools/check-selftest.mjs']);
  for (const script of ['make-pdf-samples', 'e2e-session-keys', 'e2e-options-save', 'e2e-reader', 'e2e-pdf-reader']) run(['tools/' + script + '.mjs']);
} else throw new Error('Usage: node tools/checks.mjs unit|browser');
