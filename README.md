# Cloud Save Server — 云存档中转服务器

接受客户端（个人知识工作台等）上传的**存档压缩包**，按账号保存；每个账号一个密码，
密码只以**哈希**形式存储与校验（客户端在本地把密码转成哈希，全程不传输、不保存明文密码）。

纯 **Node 零依赖**（仅用内置模块），克隆即可运行，无需 npm install。

## 部署（你的服务器 8.134.49.22）

```bash
git clone <本仓库地址> cloud-save-server
cd cloud-save-server
node server.js          # 默认监听 0.0.0.0:8848
```

可选环境变量：
| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8848` | 监听端口（TCP） |
| `DATA_DIR` | `./data` | 数据存储目录（账号 + 存档） |
| `MAX_KEEP` | `20` | 每账号保留的存档版本数（超出自动清理最旧的） |
| `MAX_UPLOAD` | `300MB` | 单次上传大小上限 |

后台常驻示例（服务器可选用 `nohup` / `pm2` / systemd）：

```bash
nohup node server.js > server.log 2>&1 &
# 或
pm2 start server.js --name cloud-save
```

> 若需公网直连，请在云服务器控制台的安全组/防火墙**放行 TCP 8848 入站**。

## 密码哈希约定（客户端必须一致）

```js
hash = sha256("kwt-cloud:" + password)   // 输出 64 位十六进制小写
```

即：**客户端**注册/登录时先用上面的算法把密码转成哈希，服务器只保存并比对这个哈希字符串。

命令行算哈希（Node）：

```bash
node -e "console.log(require('crypto').createHash('sha256').update('kwt-cloud:'+process.argv[1]).digest('hex'))" 你的密码
```

## 接口

统一鉴权参数：`username` + `passwordHash`（URL query；POST 也可放 body）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/register` | body `{"username":"xxx","passwordHash":"<64hex>"}` 注册账号 |
| POST | `/api/auth` | body 同上，校验凭据并返回账号信息（存档数/最近保存） |
| POST | `/api/save?username&passwordHash` | body 为存档**压缩包二进制**（如 .zip），保存为新版本 |
| GET | `/api/archives?username&passwordHash` | 版本列表（含时间/大小/id） |
| GET | `/api/archive/latest?username&passwordHash` | 下载最新存档压缩包 |
| GET | `/api/archive?username&passwordHash&id=<id>` | 下载指定版本 |
| DELETE | `/api/archive?username&passwordHash&id=<id>` | 删除指定版本 |

### curl 示例

```bash
# 1. 算哈希（客户端本地）
HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('kwt-cloud:mypass').digest('hex'))")

# 2. 注册
curl -X POST http://8.134.49.22:8848/api/register \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice\",\"passwordHash\":\"$HASH\"}"

# 3. 上传存档（data.zip 为本地打包好的存档）
curl -X POST "http://8.134.49.22:8848/api/save?username=alice&passwordHash=$HASH" \
  --data-binary @data.zip -H 'Content-Type: application/zip'

# 4. 下载最新存档
curl -o latest.zip "http://8.134.49.22:8848/api/archive/latest?username=alice&passwordHash=$HASH"

# 5. 查看版本列表
curl "http://8.134.49.22:8848/api/archives?username=alice&passwordHash=$HASH"
```

## 数据存储结构

```
data/
├── accounts.json          # [{username, passwordHash, createdAt, ...}]  仅哈希，无明文
└── archives/
    └── <username>/
        └── save-2026-08-24T12-30-00-000Z.zip   # 每次上传一个新版本
```

## 安全说明

- 服务器**不接收、不保存明文密码**，仅比对哈希字符串。
- 注意：哈希在此设计中即“凭据”——若泄漏他人可冒充登录，请自行保管；如要更高安全性，
  建议后续升级为服务器端随机盐 + 慢哈希（scrypt/argon2）验证。
- 建议在公网使用前配合反向代理加 TLS（https）。
