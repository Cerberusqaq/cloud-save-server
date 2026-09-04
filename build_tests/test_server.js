// 云存档服务器集成测试：node build_tests/test_server.js
// 模拟客户端完整流程：注册 → 上传存档(zip) → 版本列表 → 下载最新 → 比对内容 → 删除
'use strict';
process.env.PORT = '8850';
process.env.DATA_DIR = require('path').join(__dirname, 'tmp-data');
process.env.MAX_KEEP = '3';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { rmSync, mkdirSync } = fs;
rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const server = require('../server.js'); // 启动
const base = 'http://127.0.0.1:8850';

// 客户端密码 → 哈希（约定：sha256("kwt-cloud:" + password)）
const passwordHash = crypto.createHash('sha256').update('kwt-cloud:test123').digest('hex');
const passwordHash2 = crypto.createHash('sha256').update('kwt-cloud:wrong').digest('hex');

async function jsonReq(method, p, data) {
  const opts = { method, headers: {} };
  if (data !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(data); }
  const res = await fetch(base + p, opts);
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
}

(async () => {
  // 等待监听
  await new Promise((r) => setTimeout(r, 400));
  let pass = 0, fail = 0;
  const t = (name, fn) => fn().then(() => { console.log('PASS', name); pass++; }).catch((e) => { console.log('FAIL', name + ':', e.message); fail++; });

  await t('health', async () => {
    const { status, j } = await jsonReq('GET', '/api/health');
    if (status !== 200 || !j.ok) throw new Error('health fail');
  });
  await t('register', async () => {
    const { status, j } = await jsonReq('POST', '/api/register', { username: 'alice', passwordHash });
    if (status !== 200 || !j.ok) throw new Error(JSON.stringify(j));
  });
  await t('register 重复账号 409', async () => {
    const { status } = await jsonReq('POST', '/api/register', { username: 'alice', passwordHash });
    if (status !== 409) throw new Error('应 409, got ' + status);
  });
  await t('auth 正确密码哈希', async () => {
    const { status, j } = await jsonReq('POST', '/api/auth', { username: 'alice', passwordHash });
    if (status !== 200 || !j.ok) throw new Error('auth fail');
  });
  await t('auth 错误密码哈希 401', async () => {
    const { status } = await jsonReq('POST', '/api/auth', { username: 'alice', passwordHash: passwordHash2 });
    if (status !== 401) throw new Error('应 401, got ' + status);
  });
  await t('明文密码不得被接受（哈希长度校验）', async () => {
    const { status } = await jsonReq('POST', '/api/register', { username: 'bob', passwordHash: '明文密码123' });
    if (status !== 400) throw new Error('应 400, got ' + status);
  });

  // 构造假存档 zip
  const zipPath = path.join(__dirname, 'sample.zip');
  fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04fake-archive-' + Date.now()));
  const zipBuf = fs.readFileSync(zipPath);

  await t('上传存档', async () => {
    const res = await fetch(base + '/api/save?username=alice&passwordHash=' + passwordHash, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zipBuf,
    });
    const j = await res.json().catch(() => ({}));
    if (res.status !== 200 || !j.ok || !j.bytes) throw new Error(JSON.stringify(j));
  });
  await t('上传未授权 401', async () => {
    const res = await fetch(base + '/api/save?username=alice&passwordHash=' + passwordHash2, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zipBuf,
    });
    if (res.status !== 401) throw new Error('应 401, got ' + res.status);
  });
  await t('版本列表', async () => {
    const { status, j } = await jsonReq('GET', '/api/archives?username=alice&passwordHash=' + passwordHash);
    if (status !== 200 || j.versions.length < 1) throw new Error('versions 空');
  });
  await t('下载最新存档（内容一致）', async () => {
    const res = await fetch(base + '/api/archive/latest?username=alice&passwordHash=' + passwordHash);
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200) throw new Error('status ' + res.status);
    if (buf.toString() !== zipBuf.toString()) throw new Error('内容不一致');
    if (!res.headers.get('Content-Type').includes('zip')) throw new Error('MIME 错');
  });

  // 版本上限：上传 MAX_KEEP(3)+2 次，只保留 3 个
  await t('版本自动清理（最多保留 3）', async () => {
    for (let i = 0; i < 4; i++) {
      await fetch(base + '/api/save?username=alice&passwordHash=' + passwordHash, {
        method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zipBuf,
      });
    }
    const { j } = await jsonReq('GET', '/api/archives?username=alice&passwordHash=' + passwordHash);
    if (j.versions.length > 3) throw new Error('应清理到 3，实际 ' + j.versions.length);
  });

  // 存储中无明文密码
  await t('存储中密码仅为哈希（无明文）', async () => {
    const raw = fs.readFileSync(path.join(process.env.DATA_DIR, 'accounts.json'), 'utf8');
    if (raw.includes('test123')) throw new Error('发现明文密码!');
    if (!raw.includes(passwordHash)) throw new Error('未存哈希');
  });

  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
