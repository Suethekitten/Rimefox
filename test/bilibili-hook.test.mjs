// Bilibili 页面主环境钩子（content/bilibili-hook.js）：真实播放器的请求写法都要能识别。
// 运行：node test/bilibili-hook.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../content/bilibili-hook.js', import.meta.url), 'utf8');
const BODY = JSON.stringify({ code: 0, data: { bvid: 'BV1xx411c7mD', cid: 1001, aid: 1, page_no: 1, subtitle: { lan: 'en-US', subtitles: [] } } });

function load(body = BODY) {
  const posted = [];
  const fetched = [];
  function FakeXHR() { this.listeners = []; this.responseType = ''; }
  FakeXHR.prototype.open = function (method, url) { this.url = url; };
  FakeXHR.prototype.addEventListener = function (type, fn) { if (type === 'load') this.listeners.push(fn); };
  FakeXHR.prototype.send = function () {
    const xhr = this;
    xhr.responseText = body;
    return Promise.resolve().then(() => xhr.listeners.forEach((fn) => fn.call(xhr)));
  };
  const win = {
    URL,
    location: { href: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1', origin: 'https://www.bilibili.com' },
    XMLHttpRequest: FakeXHR,
    postMessage(data) { posted.push(data); },
    addEventListener() {},
    fetch(input) {
      fetched.push(input);
      return Promise.resolve({ clone: () => ({ text: () => Promise.resolve(body) }) });
    }
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(source, win, { filename: 'content/bilibili-hook.js' });
  return { win, posted, fetched };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function xhr(env, url) {
  const request = new env.win.XMLHttpRequest();
  request.open('GET', url);
  await request.send();
  await settle();
  return request;
}

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name); } catch (err) { fail += 1; console.log('  ✗ ' + name + '\n      ' + (err && err.message)); }
}

console.log('\n[播放器元数据请求识别]');

await t('XHR 协议相对地址（真实播放器写法 //api.bilibili.com/x/player/wbi/v2）被识别，转发绝对地址', async () => {
  const env = load();
  await xhr(env, '//api.bilibili.com/x/player/wbi/v2?aid=1&cid=1001&w_rid=x');
  assert.equal(env.posted.length, 1);
  assert.equal(env.posted[0].source, 'rimefox-bili');
  assert.equal(env.posted[0].url, 'https://api.bilibili.com/x/player/wbi/v2?aid=1&cid=1001&w_rid=x');
});

await t('XHR 绝对 https 地址、旧 /x/player/v2、站内相对地址都被识别', async () => {
  const env = load();
  await xhr(env, 'https://api.bilibili.com/x/player/wbi/v2?cid=1');
  await xhr(env, '//api.bilibili.com/x/player/v2?cid=2');
  await xhr(env, '/x/player/wbi/v2?cid=3');
  assert.equal(env.posted.length, 3);
});

await t('fetch 传 URL 对象 / Request 对象 / 协议相对字符串都被识别', async () => {
  const env = load();
  await env.win.fetch(new URL('https://api.bilibili.com/x/player/wbi/v2?cid=1'));
  await env.win.fetch({ url: 'https://api.bilibili.com/x/player/v2?cid=2' });
  await env.win.fetch('//api.bilibili.com/x/player/wbi/v2?cid=3');
  await settle();
  assert.equal(env.posted.length, 3);
});

await t('其它接口 / 其它主机 / http 不转发', async () => {
  const env = load();
  await xhr(env, '//api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD');
  await xhr(env, 'https://evil.example/x/player/wbi/v2?cid=1');
  await xhr(env, 'http://api.bilibili.com/x/player/wbi/v2?cid=1');
  await xhr(env, '//api.bilibili.com/x/player/wbi/v2extra?cid=1');
  await env.win.fetch('https://api.bilibili.com/x/player/playurl?cid=1');
  await settle();
  assert.equal(env.posted.length, 0);
});

await t('回包不是有效的播放器元数据就不转发', async () => {
  const env = load(JSON.stringify({ code: -404, data: null }));
  await xhr(env, '//api.bilibili.com/x/player/wbi/v2?cid=1');
  assert.equal(env.posted.length, 0);
});

console.log('\n[不改变页面行为]');

await t('页面传入的对象读 url 出错时，fetch 不抛出、照常调用原生 fetch', async () => {
  const env = load();
  const hostile = { get url() { throw new Error('boom'); } };
  let threw = false;
  try { await env.win.fetch(hostile); } catch (err) { threw = true; }
  assert.equal(threw, false);
  assert.equal(env.fetched.length, 1);
  assert.equal(env.posted.length, 0);
});

await t('XHR 对象上不留扩展自己的属性', async () => {
  const env = load();
  const request = await xhr(env, '//api.bilibili.com/x/player/wbi/v2?cid=1');
  assert.deepEqual(Object.keys(request).filter((k) => /rimefox/i.test(k)), []);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
