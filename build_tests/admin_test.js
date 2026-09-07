// 管理员接口集成测试：node build_tests/admin_test.js
// 覆盖：管理员鉴权、用户总览、代管云曲库（列/传/下/删）、代管云存档（列/替用户保存/下载/删除）、非管理员 401
'use strict';
process.env.PORT = '8851';
process.env.DATA_DIR = require('path').join(__dirname, 'tmp-admin-data');
process.env.MAX_KEEP = '5';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { rmSync } = fs;
rmSync(process.env.DATA_DIR, { recursive: true, force: true });

// 预置管理员账号 alice（accounts.json 标记 admin:true），服务启动即读取
const hash = (p) => crypto.createHash('sha256').update('kwt-cloud:' + p).digest('hex');
const adminHash = hash('admin-pass');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.DATA_DIR, 'accounts.json'), JSON.stringify([
  { username: 'alice', passwordHash: adminHash, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), saves: 0, lastSaveAt: null, admin: true },
], null, 2));

const server = require('../server.js'); // 启动
const base = 'http://127.0.0.1:8851';
const bobHash = hash('bob-pass');

async function jsonReq(method, p, data) {
  const opts = { method, headers: {} };
  if (data !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(data); }
  const res = await fetch(base + p, opts);
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
}
const A = 'username=alice&passwordHash=' + adminHash;     // 管理员
const B = 'username=bob&passwordHash=' + bobHash;         // 普通用户

(async () => {
  await new Promise((r) => setTimeout(r, 400));
  let pass = 0, fail = 0;
  const t = (name, fn) => fn().then(() => { console.log('PASS', name); pass++; }).catch((e) => { console.log('FAIL', name + ':', e.message); fail++; });
  const zip = Buffer.from('PK\x03\x04fake-archive-' + Date.now());

  await t('普通用户注册 bob', async () => {
    const { status, j } = await jsonReq('POST', '/api/register', { username: 'bob', passwordHash: bobHash });
    if (status !== 200 || !j.ok) throw new Error(JSON.stringify(j));
  });
  await t('bob 用普通账号访问管理员接口应 401', async () => {
    const { status } = await jsonReq('GET', '/api/admin/users?' + B);
    if (status !== 401) throw new Error('应 401, got ' + status);
  });
  await t('alice(管理员) 用户总览含自己与 bob', async () => {
    const { status, j } = await jsonReq('GET', '/api/admin/users?' + A);
    if (status !== 200 || !j.ok) throw new Error(JSON.stringify(j));
    const names = j.users.map((u) => u.username);
    if (!names.includes('alice') || !names.includes('bob')) throw new Error('缺用户: ' + names.join(','));
    const alice = j.users.find((u) => u.username === 'alice');
    if (!alice.admin) throw new Error('alice 应标记管理员');
    if (typeof alice.saves !== 'number' || typeof alice.mediaCount !== 'number') throw new Error('统计字段缺失');
  });
  await t('bob 错误密码访问管理员 401', async () => {
    const { status } = await jsonReq('GET', '/api/admin/users?username=alice&passwordHash=deadbeef');
    if (status !== 401) throw new Error('应 401, got ' + status);
  });

  // ---- 代管 bob 的云曲库 ----
  const mp3 = Buffer.from('ID3-admin-test-' + Date.now());
  await t('管理员给 bob 上传歌曲', async () => {
    const res = await fetch(base + `/api/admin/media/upload?${A}&target=bob&name=demo.mp3`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: mp3,
    });
    const j = await res.json().catch(() => ({}));
    if (res.status !== 200 || !j.ok) throw new Error(JSON.stringify(j));
  });
  await t('管理员查看 bob 曲库列表', async () => {
    const { status, j } = await jsonReq('GET', `/api/admin/media?${A}&target=bob`);
    if (status !== 200 || j.files.length !== 1 || j.files[0].name !== 'demo.mp3') throw new Error(JSON.stringify(j));
  });
  await t('管理员下载 bob 歌曲（内容一致）', async () => {
    const res = await fetch(base + `/api/admin/media/download?${A}&target=bob&name=demo.mp3`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || buf.toString() !== mp3.toString()) throw new Error('内容不一致');
  });
  await t('管理员删除 bob 歌曲', async () => {
    const { status, j } = await jsonReq('DELETE', `/api/admin/media?${A}&target=bob&name=demo.mp3`);
    if (status !== 200 || !j.ok) throw new Error(JSON.stringify(j));
    const { j: list } = await jsonReq('GET', `/api/admin/media?${A}&target=bob`);
    if (list.files.length !== 0) throw new Error('应已删空');
  });

  // ---- 代管 bob 的云存档 ----
  await t('bob 自己上传存档(1)', async () => {
    const res = await fetch(base + '/api/save?' + B, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip });
    const j = await res.json().catch(() => ({}));
    if (res.status !== 200 || !j.ok) throw new Error(JSON.stringify(j));
  });
  await t('管理员查看 bob 存档版本(1)', async () => {
    const { status, j } = await jsonReq('GET', `/api/admin/archives?${A}&target=bob`);
    if (status !== 200 || j.versions.length !== 1) throw new Error(JSON.stringify(j));
  });
  const zip2 = Buffer.from('PK\x03\x04admin-pushed-' + Date.now());
  await t('管理员替 bob 保存新存档(2)', async () => {
    const res = await fetch(base + `/api/admin/archive/save?${A}&target=bob`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip2,
    });
    const j = await res.json().catch(() => ({}));
    if (res.status !== 200 || !j.ok || !j.file) throw new Error(JSON.stringify(j));
  });
  await t('下载 bob 最新存档=管理员刚存的版本', async () => {
    const res = await fetch(base + `/api/admin/archive/latest?${A}&target=bob`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || buf.toString() !== zip2.toString()) throw new Error('最新版本内容不一致');
  });
  await t('按 id 下载 bob 的指定版本', async () => {
    const { j: list } = await jsonReq('GET', `/api/admin/archives?${A}&target=bob`);
    const id = list.versions[list.versions.length - 1].id; // 最新一版
    const res = await fetch(base + `/api/admin/archive?${A}&target=bob&id=${encodeURIComponent(id)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || buf.toString() !== zip2.toString()) throw new Error('按 id 下载内容不一致');
  });
  await t('管理员删除 bob 的一个存档版本', async () => {
    const { j: list } = await jsonReq('GET', `/api/admin/archives?${A}&target=bob`);
    if (list.versions.length !== 2) throw new Error('应 2 个版本, got ' + list.versions.length);
    const id = list.versions[0].id;
    const { status, j } = await jsonReq('DELETE', `/api/admin/archive?${A}&target=bob&id=${encodeURIComponent(id)}`);
    if (status !== 200 || !j.ok) throw new Error(JSON.stringify(j));
    const { j: list2 } = await jsonReq('GET', `/api/admin/archives?${A}&target=bob`);
    if (list2.versions.length !== 1) throw new Error('删除后应剩 1');
  });

  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  // 稍等再退出，避免 Windows 上 libuv 句柄关闭竞态导致的断言噪音
  setTimeout(() => process.exit(fail ? 1 : 0), 200);
})().catch((e) => { console.error('FATAL:', e.message); setTimeout(() => process.exit(1), 200); });
