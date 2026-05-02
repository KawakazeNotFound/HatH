# H@H Cloudflare Worker 中文说明

这个目录里放的是 H@H 遥测统计用的 Cloudflare Worker。它负责接收客户端心跳和请求事件，把高频事件先聚合起来，再把汇总后的结果写入 D1，同时提供统计查询 API 和缓存浏览器页面。

## 文件说明

- `worker.js`: Worker 入口、API 处理逻辑、缓存浏览器 HTML，以及 `HathStatsDurableObject` 类。
- `schema.sql`: D1 数据库表结构。
- `wrangler.toml`: Cloudflare 部署配置，包含 D1 绑定和 Durable Object 绑定。

## 当前架构

现在的写入链路和读取链路是分开的，目的是避免 D1 和 KV 的每日配额被高频 telemetry 打爆。

```text
H@H 客户端
  -> POST /v1/ingest
  -> Worker 鉴权
  -> HATH_STATS Durable Object
  -> 内存中按小时聚合
  -> Durable Object storage 定期 checkpoint
  -> 每小时或手动 flush
  -> D1
  -> 查询 API 和缓存浏览器
```

当前方案 **不使用 KV**。原因是：如果每次 ingest 都对 KV 做 `get/put`，KV operations 也会很快撞每日限制。Durable Object 更适合这个场景，因为它可以把热点统计留在内存里，周期性 checkpoint，并且只把压缩后的汇总结果写入 D1。

## 从客户端心跳开始

客户端会定时向 Worker 发送心跳和下载事件：

```text
POST /v1/ingest
Authorization: Bearer <HATH_INGEST_TOKEN>
Content-Type: application/json
```

典型请求体：

```json
{
  "client_id": 1,
  "name": "JP-1",
  "cache_url": "https://example:8082/local/cache/token=...",
  "uptime_s": 12345,
  "timeout": 600,
  "files_sent": 100,
  "bytes_sent": 0,
  "cache_count": 2000,
  "cache_size": 123456789,
  "open_connections": 2,
  "events": [
    {
      "fileid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1-jpg",
      "ip": "1.2.3.4",
      "bytes": 123456,
      "ts": 1777757041
    }
  ]
}
```

Worker 收到 `/v1/ingest` 后会先检查 `HATH_INGEST_TOKEN`。鉴权通过后，Worker 会从 Cloudflare/request headers 里取客户端 IP，然后把请求转发给全局 Durable Object：

```js
env.HATH_STATS.idFromName("global")
```

也就是说，所有客户端目前都会进入同一个名为 `global` 的 Durable Object 实例。这样可以让统计聚合在单线程里串行处理，避免并发写入互相覆盖。

## Durable Object 如何聚合

Durable Object 内部主要维护两个内存 Map：

```text
clients:
  client_ip -> 最新客户端心跳状态

stats:
  client_ip -> 当前小时的请求统计桶
```

`clients` 里保存的是客户端最新状态，例如：

- `name`
- `cache_url`
- `last_seen_ts`
- `timeout_s`
- `uptime_s`
- `files_sent`
- `cache_count`
- `cache_size`
- `open_connections`

`stats` 里保存的是请求事件聚合，分成两类：

```text
files[fileid]:
  request_count
  bytes_sent
  last_seen_ts

ips[requester_ip]:
  request_count
  bytes_sent
  last_seen_ts
```

举例：如果同一个小时内，同一个文件被请求了 1000 次，Durable Object 不会写 1000 次 D1，而是在内存里合并成一条统计：

```text
request_count += 1000
bytes_sent += 总字节数
last_seen_ts = 最大时间戳
```

这就是现在能保护 D1 rows written 配额的关键。

## Checkpoint 机制

Durable Object 的内存状态会定期保存到 Durable Object storage。

当前 `worker.js` 里的参数是：

```js
const DO_CHECKPOINT_INTERVAL_S = 60;
const DO_CHECKPOINT_EVENT_LIMIT = 1000;
```

满足任意一个条件就会 checkpoint：

- 距离上次 checkpoint 超过 60 秒
- 自上次 checkpoint 后累计收到 1000 个 events

checkpoint 的作用是降低 Durable Object 重启时的数据丢失窗口。当前配置下，理论上最坏可能丢失约 60 秒或 1000 个 events 内尚未 checkpoint 的聚合数据。

如果你想更稳，可以调低这两个值；如果把 `DO_CHECKPOINT_EVENT_LIMIT` 改成 `1`，每次有事件都会 checkpoint，但 Durable Object storage 写入会明显增加。

## 什么时候写 D1

D1 不再按每个 event 写入，而是在聚合后写入。

写 D1 的时机有三种：

1. **跨小时**
   当新的 ingest 请求进入下一个小时桶时，Durable Object 会把上一个小时的聚合数据写入 D1。

2. **Durable Object alarm**
   Durable Object 每小时会有一次 alarm，自动调用 `flushExpired()`，把已经过期的小时桶写入 D1。

3. **手动 flush**
   运维时可以手动把当前缓冲区写入 D1。

手动 flush 当前请求来源 client：

```text
POST /v1/flush
Authorization: Bearer <HATH_INGEST_TOKEN>
```

手动 flush 所有当前缓冲数据：

```text
POST /v1/flush?all=1
Authorization: Bearer <HATH_INGEST_TOKEN>
```

手动 flush 某个 client：

```text
POST /v1/flush?client_ip=<client_ip>
Authorization: Bearer <HATH_INGEST_TOKEN>
```

返回示例：

```json
{
  "ok": true,
  "mode": "durable_object",
  "client_ip": null,
  "flushed": 148,
  "client_writes": 5,
  "stat_writes": 143
}
```

含义：

- `client_writes`: 写入/更新了多少条 `clients`
- `stat_writes`: 写入/更新了多少条 `file_stats` + `ip_stats`
- `flushed`: 两者合计

## D1 表结构

`schema.sql` 里有三张表。

### `clients`

每个客户端 IP 一行，保存最近一次心跳状态：

```text
client_ip primary key
name
cache_url
last_seen_ts
timeout_s
uptime_s
files_sent
bytes_sent
cache_count
cache_size
open_connections
```

### `file_stats`

每个 `(client_ip, fileid)` 一行。

写入时是 upsert：

```text
request_count += 聚合后的请求数
bytes_sent += 聚合后的字节数
last_seen_ts = max(已有值, 聚合值)
```

### `ip_stats`

每个 `(client_ip, requester_ip)` 一行。

写入时同样是 upsert：

```text
request_count += 聚合后的请求数
bytes_sent += 聚合后的字节数
last_seen_ts = max(已有值, 聚合值)
```

## 完整 API 清单

所有公开路由都需要 token。写入/运维类接口使用 `HATH_INGEST_TOKEN`；读取和浏览器接口使用 `HATH_READ_TOKEN`。

`HATH_INGEST_TOKEN` 只能通过 header 传入：

```http
Authorization: Bearer <HATH_INGEST_TOKEN>
X-Auth-Token: <HATH_INGEST_TOKEN>
```

`HATH_READ_TOKEN` 可以通过 header 传入；为了方便浏览器访问，也可以用 `?token=<HATH_READ_TOKEN>`：

```http
Authorization: Bearer <HATH_READ_TOKEN>
X-Auth-Token: <HATH_READ_TOKEN>
```

注意：当前 `worker.js` 里如果某个 secret binding 没配置，`requireAuth()` 会把对应 token 类型视为“不启用鉴权”。对外暴露 Worker 前，必须确认 `HATH_INGEST_TOKEN` 和 `HATH_READ_TOKEN` 都已经配置。

查询接口只读 D1，不读取 Durable Object 当前内存里的未 flush 数据。因此刚刚 ingest 的数据不一定会立刻出现在页面上，要等下一次每小时 flush 或手动 flush。

### 写入和刷新接口

`POST /v1/ingest`

需要 `HATH_INGEST_TOKEN`。接收客户端心跳和请求事件，然后转发给全局 Durable Object 做聚合。

JSON body 字段：

- `client_id`: 必填，数字客户端 ID。
- `ts`: 可选，Unix 秒级时间戳；默认使用 Worker 当前时间。
- `name`: 可选，客户端名称。
- `cache_url`: 可选，客户端 cache browser URL。
- `timeout`: 可选，活跃超时时间，单位秒；最小 60，默认 600，最大 43200。
- `uptime_s`、`files_sent`、`bytes_sent`、`cache_count`、`cache_size`、`open_connections`: 可选客户端计数器。
- `events`: 可选请求事件数组。每个事件可以包含 `fileid`、`ip`、`bytes`、`ts`。

`POST /v1/flush`

需要 `HATH_INGEST_TOKEN`。把 Durable Object 里缓冲的聚合数据写入 D1。

Query 参数：

- `client_ip`: 可选，指定要 flush 的客户端 IP。不传时使用 Worker 推导出的客户端 IP。
- `all=1` 或 `all=true`: flush 所有客户端，而不是单个客户端。

`GET /v1/refresh`

需要 `HATH_READ_TOKEN`。浏览器/运维方便使用的全量 flush 入口，等价于内部 `POST /flush?all=1`。

`POST /v1/refresh`

同 `GET /v1/refresh`。需要 `HATH_READ_TOKEN`。

### 读取接口

`GET /v1/overview`

需要 `HATH_READ_TOKEN`。返回全局概览、活跃客户端数、总请求数，以及每个客户端的 top file/top requester IP。

Query 参数：

- `tz`: 可选时区偏移。绝对值 `<= 24` 时按小时处理；更大的值按分钟处理，并限制在 +/- 1440 分钟内。

`GET /v1/clients`

需要 `HATH_READ_TOKEN`。按 `last_seen_ts` 倒序列出客户端记录。

Query 参数：

- `limit`: 可选返回数量；默认 200，最大 1000。
- `tz`: 可选时区偏移。

`GET /v1/top/files`

需要 `HATH_READ_TOKEN`。查询某个客户端请求最多的文件。

Query 参数：

- `client_ip` 或 `name`: 二选一。两者都不传时，这个接口会返回 `missing_client`。
- `limit`: 可选返回数量；默认 50，最大 500。
- `tz`: 可选时区偏移。

`GET /v1/cache/files`

`GET /v1/top/files` 的别名。需要 `HATH_READ_TOKEN`，参数相同。

`GET /v1/top/ips`

需要 `HATH_READ_TOKEN`。查询某个客户端请求最多的 requester IP。

Query 参数：

- `client_ip` 或 `name`: 二选一。两者都不传时，这个接口会返回 `missing_client`。
- `limit`: 可选返回数量；默认 50，最大 500。
- `tz`: 可选时区偏移。

### 缓存浏览器接口

`GET /cache`

需要 `HATH_READ_TOKEN`。返回缓存浏览器 HTML 页面。

Query 参数：

- `name`: 可选，初始选中的客户端名称。

`GET /v1/cache`

`GET /cache` 的别名。需要 `HATH_READ_TOKEN`。

`GET /v1/cache/browser`

`GET /cache` 的别名。需要 `HATH_READ_TOKEN`。

`GET /v1/cache/tree`

需要 `HATH_READ_TOKEN`。代理访问选中 H@H 客户端的本地 cache browser list 接口，返回目录/文件列表。

Query 参数：

- `client_ip`: 可选客户端选择器。
- `name`: 可选客户端选择器。
- `prefix`: 可选 hex 前缀，0 到 40 个字符；非 hex 会返回 `invalid_prefix`。
- `limit`: 可选返回数量；默认 500，最大 1000。
- `offset`: 可选分页偏移；默认 0。

如果没有传 `client_ip` 或 `name`，会使用最近一个 `cache_url` 非空的客户端。

`GET /v1/cache/file`

需要 `HATH_READ_TOKEN`。从选中的 H@H 客户端代理读取单个缓存文件，并以 inline 方式流式返回。

Query 参数：

- `fileid`: 必填，H@H cache file id，格式为 `<40位hex>-<size>[-<x>-<y>]-<type>`。
- `client_ip`: 可选客户端选择器。
- `name`: 可选客户端选择器。

`GET /v1/cache/probe`

需要 `HATH_READ_TOKEN`。测试 Worker 是否能访问选中客户端的 cache browser list 接口。

Query 参数：

- `client_ip`: 可选客户端选择器。
- `name`: 可选客户端选择器。

### Durable Object 内部接口

`POST /ingest` 和 `POST /flush` 只存在于 `HathStatsDurableObject.fetch()` 内部，不是公开 Worker API。外部调用应使用 `/v1/ingest` 和 `/v1/flush`，这两个公开入口会先校验 token，再转发给 Durable Object。

想立即看到最新缓冲数据，可以先执行：

```text
POST /v1/flush?all=1
```

然后再查询 overview/top 接口。

## Cloudflare 绑定配置

`wrangler.toml` 里需要有 D1 和 Durable Object 绑定：

```toml
[[d1_databases]]
binding = "HATH_DB"
database_name = "hath_stats"
database_id = "<your-d1-database-id>"

[[durable_objects.bindings]]
name = "HATH_STATS"
class_name = "HathStatsDurableObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = [ "HathStatsDurableObject" ]
```

Cloudflare 现在推荐新的 Durable Object namespace 使用 `new_sqlite_classes`。第一次部署后，`migrations` 里的 tag 不要删除，后续部署仍然要保留。

需要设置两个 secret：

```text
HATH_INGEST_TOKEN
HATH_READ_TOKEN
```

设置命令：

```powershell
npx wrangler secret put HATH_INGEST_TOKEN
npx wrangler secret put HATH_READ_TOKEN
```

## 部署

如果当前目录是 `Workers`：

```powershell
npx wrangler deploy
```

如果当前目录是仓库根目录：

```powershell
npx wrangler deploy --config Workers/wrangler.toml
```

## 测试命令

PowerShell 里 `curl` 默认是 `Invoke-WebRequest` 的别名，容易把 Linux/macOS 的 curl 命令搞坏。建议用 `Invoke-RestMethod` 或 `curl.exe`。

心跳测试：

```powershell
$body = @{
  client_id = 1
  name = "do-test"
  uptime_s = 1
  events = @()
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri "https://<worker-domain>/v1/ingest" `
  -Method Post `
  -Headers @{ Authorization = "Bearer <HATH_INGEST_TOKEN>" } `
  -ContentType "application/json" `
  -Body $body
```

期望返回：

```json
{
  "ok": true,
  "mode": "durable_object",
  "events": 0,
  "flushed": 1
}
```

带事件测试：

```powershell
$ts = [int][double]::Parse((Get-Date -UFormat %s))
$body = @{
  client_id = 1
  name = "do-test"
  uptime_s = 2
  events = @(
    @{
      fileid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-1-jpg"
      ip = "5.6.7.8"
      bytes = 456
      ts = $ts
    }
  )
} | ConvertTo-Json -Depth 6

Invoke-RestMethod `
  -Uri "https://<worker-domain>/v1/ingest" `
  -Method Post `
  -Headers @{ Authorization = "Bearer <HATH_INGEST_TOKEN>" } `
  -ContentType "application/json" `
  -Body $body
```

手动全量 flush：

```powershell
Invoke-RestMethod `
  -Uri "https://<worker-domain>/v1/flush?all=1" `
  -Method Post `
  -Headers @{ Authorization = "Bearer <HATH_INGEST_TOKEN>" }
```

读取 top files：

```powershell
$readToken = "<HATH_READ_TOKEN>"
$url = "https://<worker-domain>/v1/top/files?name=do-test&token=" + [uri]::EscapeDataString($readToken)
Invoke-RestMethod -Uri $url
```

## 运维注意事项

- 不要在 ingest 热路径上使用 KV；高频请求会快速耗尽 KV operations。
- 不要每个 event 直接写 D1；必须先聚合。
- Durable Object storage checkpoint 是“稳定性”和“写入量”的平衡点。
- 查询接口是最终一致的：它们只读 D1，不读 DO 当前内存。
- 需要最新数据时，用 `POST /v1/flush?all=1`。
- 如果 `/v1/ingest` 返回 `missing_durable_object`，说明 `HATH_STATS` 绑定或 Durable Object migration 没配好。
- 如果 `/v1/ingest` 返回 `invalid_json`，一般是请求体 JSON 坏了，PowerShell 下尤其常见。
- 如果查询接口返回 `401`，检查 `HATH_READ_TOKEN`；ingest token 和 read token 是分开的。
- 如果 Cloudflare 提醒 D1 rows written 接近限制，优先检查是否误部署了旧版逐 event 写入代码。
- 如果 Cloudflare 提醒 KV operations 接近限制，优先检查当前部署是否仍在使用旧 KV 聚合版本。
