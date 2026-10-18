import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(resolve(tmpdir(), 'rimefox-store-test-'));
try {
  for (const name of ['manifest.json', 'background.js', 'lib', 'content', 'options', 'popup', 'icons', 'tools', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'licenses']) await cp(resolve(source,name), resolve(temp,name), {recursive:true});
  await writeFile(resolve(temp,'lib/.DS_Store'),'exclude me');
  for (const name of ['Thumbs.db', 'desktop.ini', '.env', 'debug.log', 'private.key', 'bundle.js.map']) await writeFile(resolve(temp,'lib',name),'exclude me');
  await mkdir(resolve(temp,'lib/test')); await writeFile(resolve(temp,'lib/test/private.txt'),'exclude me');
  const script = resolve(temp,'tools/package-store.mjs');
  const run = () => spawnSync(process.execPath,[script],{cwd:tmpdir(),encoding:'utf8'});
  let result=run(); assert.equal(result.status,0,result.stderr);
  const m=JSON.parse(await readFile(resolve(temp,'manifest.json'),'utf8'));
  const zip=await readFile(resolve(temp,`dist/Rimefox-v${m.version}-store.zip`));
  const names=[]; let p=0;
  while(zip.readUInt32LE(p)===0x04034b50){
    const size=zip.readUInt32LE(p+18), n=zip.readUInt16LE(p+26), x=zip.readUInt16LE(p+28);
    const name=zip.subarray(p+30,p+30+n).toString(); names.push(name);
    const data=inflateRawSync(zip.subarray(p+30+n+x,p+30+n+x+size));
    assert.deepEqual(data,await readFile(resolve(temp,name)));
    p+=30+n+x+size;
  }
  assert(names.includes('manifest.json')); assert(names.includes('lib/privacy.js'), 'privacy module must be packaged');
  assert(names.includes('LICENSE')); assert(names.includes('THIRD-PARTY-NOTICES.md')); assert(names.includes('licenses/oneaifw-MIT.txt'));
  assert(!names.some(n=>/DS_Store|Thumbs|desktop.ini|\.env|debug.log|private.key|\.map$|\/test\/|^tools\/|icons\/(source|preview-|icon512)/.test(n)));
  assert.equal(zip.readUInt32LE(p),0x02014b50);
  assert.equal(run().status,0); assert.deepEqual(await readFile(resolve(temp,`dist/Rimefox-v${m.version}-store.zip`)),zip);
  const core=await readFile(resolve(temp,'content/core.js'),'utf8');
  await writeFile(resolve(temp,'content/core.js'),core.replace(/DT.VERSION\s*=\s*['"][^'"]+['"]/,"DT.VERSION = '99.0.0'"));
  result=run(); assert.notEqual(result.status,0); assert.match(result.stderr,/mismatch/);
  await writeFile(resolve(temp,'content/core.js'),core);
  await rm(resolve(temp,m.icons['16'])); result=run(); assert.notEqual(result.status,0); assert.match(result.stderr,/16px/);
  assert.deepEqual(await readFile(resolve(temp,`dist/Rimefox-v${m.version}-store.zip`)),zip,'failed checks must preserve previous output');
  console.log('Store packaging: contents, exclusions, independent cwd, reproducibility, version/icon failure guards PASS');
} finally {await rm(temp,{recursive:true,force:true});}
