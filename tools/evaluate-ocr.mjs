// Real-image evaluation, local native connector only. Input JSON stays outside the repository.
// node tools/evaluate-ocr.mjs reader/pdf-real/ocr-preview/cases.json
// Cases: [{id,file (PNG), languages:[BCP47], reference?:manual excerpt, notes?:string}]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createNativeOcrSource } from '../lib/ocr/native-source.js';
import { encodeFrame, createFrameReader } from './ocr-mock-host/host.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(process.argv[2] || 'reader/pdf-real/ocr-preview/cases.json');
const binary = process.env.RIMEFOX_OCR_HOST || path.join(root, 'native/ocr-host', process.platform === 'darwin' ? 'macos/build/rimefox-ocr-host' : 'windows/build/rimefox-ocr-host.exe');
const cases = JSON.parse(fs.readFileSync(input, 'utf8'));
const normalize = text => String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
// Minimum edit distance to any contiguous output substring, not whole-page CER.
function excerptError(reference, output) {
  const a = Array.from(normalize(reference)), b = Array.from(normalize(output));
  if (!a.length) return null;
  let row = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const next = new Uint32Array(b.length + 1); next[0] = i;
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  const edits = Math.min(...row);
  return { normalizedReferenceCharacters: a.length, edits, excerptCER: edits / a.length };
}
const children = [];
const source = createNativeOcrSource({ hasPermission: async () => true, clientVersion: 'quality-probe', connect() {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }); children.push(child);
  const messages = [], disconnect = [];
  child.stdout.on('data', createFrameReader(m => messages.forEach(fn => fn(m))));
  child.on('exit', () => disconnect.forEach(fn => fn()));
  return { postMessage: m => child.stdin.write(encodeFrame(m)), disconnect: () => child.kill(),
    onMessage: { addListener: fn => messages.push(fn) }, onDisconnect: { addListener: fn => disconnect.push(fn) } };
}});
const results = [];
try {
  const detected = await source.detect({ refresh: true });
  for (const one of cases) {
    const file = path.resolve(path.dirname(input), one.file), png = fs.readFileSync(file);
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Use a decoded PNG input: ' + file);
    const started = Date.now();
    const result = await source.recognize({ backend: 'system', languages: one.languages || [], image: {
      mime: 'image/png', width: png.readUInt32BE(16), height: png.readUInt32BE(20), data: png.toString('base64') } });
    const text = result.lines.map(line => line.text).join('\n');
    const output = { ...result, id: one.id, notes: one.notes, wallMs: Date.now() - started, text,
      input: { file: one.file, width: png.readUInt32BE(16), height: png.readUInt32BE(20), sha256: createHash('sha256').update(png).digest('hex'), source: one.source },
      excerpt: one.reference ? excerptError(one.reference, text) : null };
    results.push(output);
    console.log(JSON.stringify({ id: one.id, wallMs: output.wallMs, durationMs: result.durationMs,
      lines: result.lines.length, characters: text.length, excerpt: output.excerpt, firstText: text.slice(0, 300) }));
  }
  const output = path.join(path.dirname(input), 'results-' + process.platform + '.json');
  fs.writeFileSync(output, JSON.stringify({ detected, cases: results }, null, 2)); console.log(output);
} finally { source.dispose(); children.forEach(child => child.kill()); }
