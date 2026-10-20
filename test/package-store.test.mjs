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
  for (const name of ['manifest.json', 'background.js', 'lib', 'content', 'options', 'popup', 'welcome', 'icons', 'tools', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'licenses', '_locales']) await cp(resolve(source,name), resolve(temp,name), {recursive:true});
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
  for (const name of ['welcome/index.html', 'welcome/welcome.css', 'welcome/welcome.js', 'lib/welcome.js']) assert(names.includes(name), name + ' must be packaged');
  assert(names.includes('LICENSE')); assert(names.includes('THIRD-PARTY-NOTICES.md')); assert(names.includes('licenses/oneaifw-MIT.txt'));
  for (const name of ['_locales/zh_CN/messages.json', '_locales/en/messages.json']) assert(names.includes(name), name + ' must be packaged');
  assert(!names.some(n=>/DS_Store|Thumbs|desktop.ini|\.env|debug.log|private.key|\.map$|\/test\/|^tools\/|icons\/(source|preview-|icon512)/.test(n)));
  assert.equal(zip.readUInt32LE(p),0x02014b50);
  assert.equal(run().status,0); assert.deepEqual(await readFile(resolve(temp,`dist/Rimefox-v${m.version}-store.zip`)),zip);
  const core=await readFile(resolve(temp,'content/core.js'),'utf8');
  await writeFile(resolve(temp,'content/core.js'),core.replace(/DT.VERSION\s*=\s*['"][^'"]+['"]/,"DT.VERSION = '99.0.0'"));
  result=run(); assert.notEqual(result.status,0); assert.match(result.stderr,/mismatch/);
  await writeFile(resolve(temp,'content/core.js'),core);
  await rm(resolve(temp,'welcome/welcome.js')); result=run(); assert.notEqual(result.status,0); assert.match(result.stderr,/welcome asset/i);
  await cp(resolve(source,'welcome/welcome.js'), resolve(temp,'welcome/welcome.js'));
  await rm(resolve(temp,m.icons['16'])); result=run(); assert.notEqual(result.status,0); assert.match(result.stderr,/16px/);
  assert.deepEqual(await readFile(resolve(temp,`dist/Rimefox-v${m.version}-store.zip`)),zip,'failed checks must preserve previous output');
  // _locales：默认语言文件缺失 / JSON 坏了 / 缺 manifest 引用的文案 key 都要拒绝出包
  const zhMessages = resolve(temp,'_locales/zh_CN/messages.json');
  const enMessages = resolve(temp,'_locales/en/messages.json');
  await rm(zhMessages); result=run(); assert.notEqual(result.status,0); assert.match(result.stderr,/default locale messages/i);
  await cp(resolve(source,'_locales/zh_CN/messages.json'), zhMessages);
  await writeFile(enMessages,'{bad json'); result=run(); assert.notEqual(result.status,0); assert.match(result.stderr,/Invalid locale messages/i);
  await cp(resolve(source,'_locales/en/messages.json'), enMessages);
  const enJson=JSON.parse(await readFile(enMessages,'utf8')); delete enJson.extensionName; await writeFile(enMessages,JSON.stringify(enJson));
  result=run(); assert.notEqual(result.status,0); assert.match(result.stderr,/Missing "extensionName"/);
  await cp(resolve(source,'_locales/en/messages.json'), enMessages);
  assert.deepEqual(await readFile(resolve(temp,`dist/Rimefox-v${m.version}-store.zip`)),zip,'locale failures must preserve previous output');
  // GitHub Release 包：同一份白名单，文件集合与商店包一致，只是多一层 Rimefox/ 文件夹
  await cp(resolve(source,m.icons['16']), resolve(temp,m.icons['16'])); // 上一步故意删掉的图标放回去
  const zipNames = (buf) => { const out=[]; let q=0; while(buf.readUInt32LE(q)===0x04034b50){ const sz=buf.readUInt32LE(q+18), n=buf.readUInt16LE(q+26), x=buf.readUInt16LE(q+28); out.push(buf.subarray(q+30,q+30+n).toString()); q+=30+n+x+sz; } return out; };
  for (const dev of ['test/x.test.mjs', 'selftest/index.html', 'docs/screenshots/01.png', 'docs/STORE.md', 'tools/extra.mjs']) {
    await mkdir(dirname(resolve(temp,dev)),{recursive:true}); await writeFile(resolve(temp,dev),'dev only');
  }
  for (const top of ['README.md', 'HANDOFF.md', 'CHANGELOG.md', 'AGENTS.md', 'PRIVACY.md', 'STORE-READINESS.md', 'package.json', '.gitattributes']) await writeFile(resolve(temp,top),'dev only');
  result=spawnSync(process.execPath,[script,'--release'],{cwd:tmpdir(),encoding:'utf8'}); assert.equal(result.status,0,result.stderr);
  const rel=await readFile(resolve(temp,`dist/Rimefox-v${m.version}.zip`));
  const relNames=zipNames(rel);
  assert(relNames.length>0 && relNames.every(n=>n.startsWith('Rimefox/')), 'Release 包的文件都要在 Rimefox/ 文件夹里');
  assert.deepEqual(relNames.map(n=>n.slice('Rimefox/'.length)), names, 'Release 包与商店包的文件集合必须一致');
  for (const legal of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'licenses/oneaifw-MIT.txt', 'manifest.json']) assert(relNames.includes('Rimefox/'+legal), legal + ' must be in the release zip');
  assert(!relNames.some(n=>/^Rimefox\/(?:test|selftest|docs|tools|dist)\//.test(n) || /^Rimefox\/(?:README|HANDOFF|CHANGELOG|AGENTS|PRIVACY|STORE-READINESS)\.md$|^Rimefox\/package\.json$|^Rimefox\/\.git/.test(n)), 'Release 包不能带测试 / 开发文档 / 商店截图：' + relNames.join(','));
  const storeAgain=await readFile(resolve(temp,`dist/Rimefox-v${m.version}-store.zip`));
  assert.deepEqual(zipNames(storeAgain), names, '打 Release 包不能改动商店包');
  console.log('Store packaging: contents, welcome assets, exclusions, independent cwd, reproducibility, version/icon failure guards PASS');
  console.log('Release packaging: same allowlist as the store zip, Rimefox/ folder, licenses kept, tests / docs / screenshots excluded PASS');
} finally {await rm(temp,{recursive:true,force:true});}
