/**
 * cloud-save-server — 云存档中转服务器（零依赖，纯 Node 内置模块）
 *
 * 功能：
 *   分账号保存客户端上传的存档压缩包；账号密码只以「哈希」形式存储与校验
 *   （客户端在本地把密码转成哈希，全程不传输/不保存明文密码）。
 *
 * 接口（默认端口 8848）：
 *   GET  /api/health              健康检查
 *   POST /api/register            body {username, passwordHash} —— 注册账号
 *   POST /api/auth                 body {username, passwordHash} —— 校验凭据，返回账号信息
 *   POST /api/save                 ?username&passwordHash ，body = 存档压缩包(二进制)
 *                                  保存为新版本（自动清理，保留最近 MAX_KEEP 个）
 *   GET  /api/archives             ?username&passwordHash —— 版本列表
 *   GET  /api/archive/latest       ?username&passwordHash —— 下载最新存档
 *   GET  /api/archive              ?username&passwordHash&id=xxx —— 下载指定版本
 *   DELETE /api/archive            ?username&passwordHash&id=xxx —— 删除指定版本
 *
 * 密码哈希约定（客户端算法须与此一致，见 README）：
 *   hash = sha256("kwt-cloud:" + password)   // 十六进制小写
 * 服务器不保存明文密码、不接收明文密码。
 *
 * 部署：
 *   git clone <repo> && cd cloud-save-server && node server.js
 * 环境变量：PORT（默认 8848）、DATA_DIR（默认 ./data）、MAX_KEEP（默认 20）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8848', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_KEEP = parseInt(process.env.MAX_KEEP || '20', 10);
const MAX_UPLOAD = parseInt(process.env.MAX_UPLOAD || (300 * 1024 * 1024), 10); // 300MB
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ARCHIVES_DIR = path.join(DATA_DIR, 'archives');
const USERNAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const HASH_RE = /^[0-9a-f]{16,128}$/i; // sha256 hex = 64；允许 scrypt 类更长

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ARCHIVES_DIR, { recursive: true });

/* ---------------- 账号存取（内存 + 原子落盘） ---------------- */
let accounts = [];
let saveQueue = Promise.resolve();
function loadAccounts() {
  try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) { accounts = []; }
}
function persistAccounts() {
  saveQueue = saveQueue.then(() => {
    const tmp = ACCOUNTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2), 'utf8');
    fs.renameSync(tmp, ACCOUNTS_FILE);
  }).catch(() => {});
}
function findUser(username) { return accounts.find((a) => a.username === username); }
function userDir(username) { return path.join(ARCHIVES_DIR, username); }

loadAccounts();

/* ---------------- 辅助 ---------------- */
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function getAuth(query) {
  const username = String(query.username || '');
  const passwordHash = String(query.passwordHash || query.password_hash || '');
  if (!USERNAME_RE.test(username) || !HASH_RE.test(passwordHash)) return null;
  const u = findUser(username);
  if (!u || u.passwordHash !== passwordHash) return null;
  return u;
}
function listVersions(username) {
  const dir = userDir(username);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const m = /^save-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.zip$/.exec(f);
      const p = path.join(dir, f);
      return { id: f, time: m ? m[1].replace(/-/g, ':') : null, size: fs.statSync(p).size, name: f };
    })
    .sort((a, b) => (a.time || '').localeCompare(b.time || '')); // 旧→新
}
/** 保留最近 MAX_KEEP 个，删除更旧的 */
function trimVersions(username) {
  const list = listVersions(username);
  const over = list.length - MAX_KEEP;
  for (let i = 0; i < over; i++) {
    try { fs.unlinkSync(path.join(userDir(username), list[i].name)); } catch (e) { /* ignore */ }
  }
}

/* ---------------- HTTP 服务器 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());

  // 简单的 CORS（非浏览器必需，保留便于调试）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-User, X-Auth-Hash');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    /* ---- 健康 ---- */
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'cloud-save-server', time: new Date().toISOString(), accounts: accounts.length });
    }

    /* ---- 注册 ---- */
    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await readJson(req);
      const username = String(body.username || '').trim();
      const passwordHash = String(body.passwordHash || '').trim();
      if (!USERNAME_RE.test(username)) return sendJson(res, 400, { ok: false, error: '用户名仅允许字母数字 _ -，长度 1-32' });
      if (!HASH_RE.test(passwordHash)) return sendJson(res, 400, { ok: false, error: 'passwordHash 无效（需为十六进制哈希）' });
      if (findUser(username)) return sendJson(res, 409, { ok: false, error: '账号已存在' });
      const rec = { username, passwordHash, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), saves: 0, lastSaveAt: null };
      accounts.push(rec);
      persistAccounts();
      fs.mkdirSync(userDir(username), { recursive: true });
      return sendJson(res, 200, { ok: true, username: rec.username, createdAt: rec.createdAt });
    }

    /* ---- 鉴权 ---- */
    if (pathname === '/api/auth' && req.method === 'POST') {
      const body = await readJson(req);
      const query2 = { username: body.username, passwordHash: body.passwordHash };
      const u = getAuth(query2);
      if (!u) return sendJson(res, 401, { ok: false, error: '账号或密码哈希不正确' });
      const versions = listVersions(u.username);
      return sendJson(res, 200, {
        ok: true, username: u.username, createdAt: u.createdAt,
        saves: versions.length, lastSaveAt: u.lastSaveAt,
        latest: versions.length ? versions[versions.length - 1] : null,
      });
    }

    /* ---- 上传存档（body 为压缩包二进制） ---- */
    if (pathname === '/api/save' && req.method === 'POST') {
      const u = getAuth(query);
      if (!u) return sendJson(res, 401, { ok: false, error: '未授权：账号或密码哈希不正确' });
      const dir = userDir(u.username);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/:/g, '-');
      const dest = path.join(dir, `save-${stamp}.zip`);
      const { bytes } = await saveBodyToFile(req, dest);
      if (bytes <= 0) { try { fs.unlinkSync(dest); } catch (e) {} return sendJson(res, 400, { ok: false, error: '上传内容为空' }); }
      trimVersions(u.username);
      u.lastSaveAt = new Date().toISOString();
      u.updatedAt = u.lastSaveAt;
      persistAccounts();
      return sendJson(res, 200, { ok: true, username: u.username, bytes, savedAt: u.lastSaveAt, file: path.basename(dest) });
    }

    /* ---- 存档版本列表 ---- */
    if (pathname === '/api/archives' && req.method === 'GET') {
      const u = getAuth(query);
      if (!u) return sendJson(res, 401, { ok: false, error: '未授权' });
      const versions = listVersions(u.username);
      return sendJson(res, 200, { ok: true, username: u.username, versions });
    }

    /* ---- 下载存档 ---- */
    if (pathname === '/api/archive/latest' && req.method === 'GET') {
      const u = getAuth(query);
      if (!u) return sendJson(res, 401, { ok: false, error: '未授权' });
      const versions = listVersions(u.username);
      if (!versions.length) return sendJson(res, 404, { ok: false, error: '该账号暂无存档' });
      return streamArchive(res, path.join(userDir(u.username), versions[versions.length - 1].name), versions[versions.length - 1].name);
    }
    if (pathname === '/api/archive' && req.method === 'GET') {
      const u = getAuth(query);
      if (!u) return sendJson(res, 401, { ok: false, error: '未授权' });
      const id = String(query.id || '');
      if (!/^save-.+\.zip$/.test(id) || id.includes('..') || id.includes('/') || id.includes('\\')) return sendJson(res, 400, { ok: false, error: 'id 无效' });
      const fp = path.join(userDir(u.username), id);
      if (!fs.existsSync(fp)) return sendJson(res, 404, { ok: false, error: '存档不存在' });
      return streamArchive(res, fp, id);
    }

    /* ---- 删除存档版本 ---- */
    if (pathname === '/api/archive' && req.method === 'DELETE') {
      const u = getAuth(query);
      if (!u) return sendJson(res, 401, { ok: false, error: '未授权' });
      const id = String(query.id || '');
      if (!/^save-.+\.zip$/.test(id) || id.includes('..') || id.includes('/') || id.includes('\\')) return sendJson(res, 400, { ok: false, error: 'id 无效' });
      const fp = path.join(userDir(u.username), id);
      if (!fs.existsSync(fp)) return sendJson(res, 404, { ok: false, error: '存档不存在' });
      fs.unlinkSync(fp);
      return sendJson(res, 200, { ok: true, deleted: id });
    }

    /* ---- 根信息 ---- */
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ service: 'cloud-save-server', version: '1.0.0', endpoints: ['/api/health', '/api/register', '/api/auth', '/api/save', '/api/archives', '/api/archive/latest', '/api/archive', 'DELETE /api/archive'] }));
      return;
    }

    return sendJson(res, 404, { ok: false, error: `接口不存在: ${req.method} ${pathname}` });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: `服务器错误: ${e.message}` });
  }
});

/* ---------------- 请求体辅助 ---------------- */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function saveBodyToFile(req, dest) {
  return new Promise((resolve, reject) => {
    const length = parseInt(req.headers['content-length'] || '0', 10);
    if (length > MAX_UPLOAD) { reject(new Error(`文件过大（上限 ${Math.round(MAX_UPLOAD / 1048576)}MB）`)); req.destroy(); return; }
    const out = fs.createWriteStream(dest);
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_UPLOAD) {
        out.destroy();
        try { fs.unlinkSync(dest); } catch (e) {}
        reject(new Error(`文件过大（上限 ${Math.round(MAX_UPLOAD / 1048576)}MB）`));
        req.destroy();
        return;
      }
    });
    req.pipe(out);
    out.on('finish', () => resolve({ bytes }));
    out.on('error', reject);
    req.on('error', (e) => { out.destroy(); try { fs.unlinkSync(dest); } catch (x) {} reject(e); });
  });
}

function streamArchive(res, filePath, name) {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Content-Length': fs.statSync(filePath).size,
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { try { res.destroy(); } catch (e) {} });
  stream.pipe(res);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  Cloud Save Server — 云存档中转服务已启动');
  console.log(`  监听: http://0.0.0.0:${PORT}  （TCP）`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  账号数: ${accounts.length} · 每账号保留最近 ${MAX_KEEP} 个存档版本`);
  console.log('============================================');
});

// 兜底：不因单个异常崩溃
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e.message); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.message); });
