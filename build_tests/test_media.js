// 云音乐库接口测试：node build_tests/test_media.js
// 上传 mp3 → 列表 → 下载比对 → 删除 → 非法文件名拒绝
'use strict';
process.env.PORT = '8852';
process.env.DATA_DIR = require('path').join(__dirname, 'tmp-media-data');
process.env.MAX_KEEP = '3';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { rmSync, mkdirSync } = fs;
rmSync(process.env.DATA_DIR, { recursive: true, force: true });

require('../server.js');
const base = 'http://127.0.0.1:8852';
const passwordHash = crypto.createHash('sha256').update('kwt-cloud:pass').digest('hex');

async function reg() {
  await fetch(base + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'musictest', passwordHash }),
  });
}
let pass = 0, fail = 0;
const t = (name, fn) => fn().then(() => { console.log('PASS', name); pass++; }).catch((e) => { console.log('FAIL', name + ':', e.message); fail++; });

(async () => {
  await new Promise((r) => setTimeout(r, 400));
  await reg();
  const auth = `username=musictest&passwordHash=${passwordHash}`;
  const fakeMp3 = Buffer.from('ID3' + 'fake-mp3-data-' + Date.now());

  await t('上传 mp3', async () => {
    const res = await fetch(base + '/api/media/upload?' + auth + '&name=' + encodeURIComponent('我的音乐 第1首.mp3'), {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: fakeMp3,
    });
    const j = await res.json();
    if (res.status !== 200 || !j.ok) throw new Error(JSON.stringify(j));
  });
  await t('上传重名覆盖（同名再次上传）', async () => {
    const res = await fetch(base + '/api/media/upload?' + auth + '&name=' + encodeURIComponent('我的音乐 第1首.mp3'), {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: Buffer.from('ID3new'),
    });
    const j = await res.json();
    if (!j.ok || !j.bytes) throw new Error(JSON.stringify(j));
  });
  await t('非法文件名被拒（路径穿越）', async () => {
    const res = await fetch(base + '/api/media/upload?' + auth + '&name=' + encodeURIComponent('../../evil.mp3'), {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: fakeMp3,
    });
    if (res.status !== 400) throw new Error('应 400, got ' + res.status);
  });
  await t('列表', async () => {
    const res = await fetch(base + '/api/media?' + auth);
    const j = await res.json();
    if (!j.ok || j.files.length !== 1) throw new Error(JSON.stringify(j));
    console.log('  文件:', j.files.map((f) => `${f.name}(${f.size}B)`).join(', '));
  });
  await t('下载比对', async () => {
    const res = await fetch(base + '/api/media/download?' + auth + '&name=' + encodeURIComponent('我的音乐 第1首.mp3'));
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.toString() !== 'ID3new') throw new Error('内容不一致: ' + buf.toString());
    if (!res.headers.get('Content-Type').includes('audio/mpeg')) throw new Error('MIME 错');
  });
  await t('删除 + 列表为空', async () => {
    const d = await fetch(base + '/api/media?' + auth + '&name=' + encodeURIComponent('我的音乐 第1首.mp3'), { method: 'DELETE' });
    if (d.status !== 200) throw new Error('删除失败');
    const l = await (await fetch(base + '/api/media?' + auth)).json();
    if (l.files.length !== 0) throw new Error('删除后仍有文件');
  });
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
