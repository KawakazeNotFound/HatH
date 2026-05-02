# H@H Cloudflare Worker

This directory contains the Cloudflare Worker used to receive H@H client telemetry, aggregate high-frequency request events, store rolled-up stats in D1, and expose read APIs plus the cache browser UI.

## Components

- `worker.js`: Worker entry point, API handlers, cache browser HTML, and the `HathStatsDurableObject` class.
- `schema.sql`: D1 table schema for persisted client and request statistics.
- `wrangler.toml`: Cloudflare deployment config, including the D1 binding and Durable Object binding.

## Runtime Architecture

The write path is intentionally split from the read path to avoid exhausting D1 and KV daily limits.

```text
H@H client
  -> POST /v1/ingest
  -> Worker auth check
  -> HATH_STATS Durable Object
  -> in-memory hourly aggregation
  -> Durable Object storage checkpoint
  -> hourly/manual flush
  -> D1
  -> read APIs and cache browser
```

KV is not used by the current design. This is deliberate: writing each ingest request to KV still burns Cloudflare Workers KV operations too quickly. Durable Objects are a better fit because one object can keep hot aggregation state in memory, checkpoint periodically, and flush compact rollups to D1.

## Ingest Flow

Clients send heartbeat and request telemetry to:

```text
POST /v1/ingest
Authorization: Bearer <HATH_INGEST_TOKEN>
Content-Type: application/json
```

Typical payload:

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

The Worker validates `HATH_INGEST_TOKEN`, determines the client IP from Cloudflare/request headers, then forwards the request to the global Durable Object instance:

```js
env.HATH_STATS.idFromName("global")
```

All clients currently share this one Durable Object instance. That keeps aggregation serialized and prevents concurrent writes from clobbering each other.

## Durable Object Aggregation

The Durable Object keeps two in-memory maps:

```text
clients:
  client_ip -> latest heartbeat/client status

stats:
  client_ip -> current hourly request aggregate
```

Client heartbeat data includes values such as:

- `name`
- `cache_url`
- `last_seen_ts`
- `timeout_s`
- `uptime_s`
- `files_sent`
- `cache_count`
- `cache_size`
- `open_connections`

Request events are aggregated into two groups:

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

For example, if the same file is requested 1,000 times in the same hour, the Durable Object keeps one aggregate record with `request_count += 1000` instead of writing 1,000 D1 rows.

## Checkpointing

The Durable Object periodically writes its in-memory aggregation state to Durable Object storage.

Current settings in `worker.js`:

```js
const DO_CHECKPOINT_INTERVAL_S = 60;
const DO_CHECKPOINT_EVENT_LIMIT = 1000;
```

This means a checkpoint happens when either condition is met:

- at least 60 seconds passed since the previous checkpoint
- at least 1,000 events were received since the previous checkpoint

This reduces the worst-case loss window if the Durable Object is restarted before the next D1 flush. With the current values, the expected maximum uncheckpointed window is roughly 60 seconds or 1,000 events.

Lowering these values improves durability but increases Durable Object storage writes. Setting the event limit to `1` gives stronger persistence, but it will write DO storage much more often.

## D1 Flush Behavior

D1 is written only after aggregation, not for every event.

Flushes happen in these cases:

- an ingest request crosses into a new hourly bucket
- the Durable Object hourly alarm runs
- an operator calls the manual flush endpoint

Manual flush:

```text
POST /v1/flush
Authorization: Bearer <HATH_INGEST_TOKEN>
```

Flush all currently buffered clients:

```text
POST /v1/flush?all=1
Authorization: Bearer <HATH_INGEST_TOKEN>
```

Flush one client:

```text
POST /v1/flush?client_ip=<client_ip>
Authorization: Bearer <HATH_INGEST_TOKEN>
```

The response includes the write counts:

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

## D1 Tables

`schema.sql` defines three tables.

### `clients`

One row per client IP. Updated with the latest heartbeat:

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

One row per `(client_ip, fileid)`:

```text
request_count += aggregated request count
bytes_sent += aggregated bytes
last_seen_ts = max(existing, aggregate)
```

### `ip_stats`

One row per `(client_ip, requester_ip)`:

```text
request_count += aggregated request count
bytes_sent += aggregated bytes
last_seen_ts = max(existing, aggregate)
```

## Complete API Reference

All public routes require a token. Ingest/operator write routes use `HATH_INGEST_TOKEN`; read and browser routes use `HATH_READ_TOKEN`.

`HATH_INGEST_TOKEN` can be supplied by header only:

```http
Authorization: Bearer <HATH_INGEST_TOKEN>
X-Auth-Token: <HATH_INGEST_TOKEN>
```

`HATH_READ_TOKEN` can be supplied by header, or as `?token=<HATH_READ_TOKEN>` for browser-friendly GET routes:

```http
Authorization: Bearer <HATH_READ_TOKEN>
X-Auth-Token: <HATH_READ_TOKEN>
```

Important: `worker.js` currently treats a missing secret binding as "auth disabled" for that token type. Make sure both `HATH_INGEST_TOKEN` and `HATH_READ_TOKEN` are configured before exposing the Worker.

Read APIs query D1 only. They do not read the current in-memory Durable Object buffer, so very recent ingest data may not appear until the next hourly/manual flush.

### Write and flush routes

`POST /v1/ingest`

Requires `HATH_INGEST_TOKEN`. Receives client heartbeat and request events, then forwards the request to the global Durable Object for aggregation.

JSON body fields:

- `client_id`: required numeric client id.
- `ts`: optional Unix timestamp in seconds; defaults to Worker time.
- `name`: optional client name.
- `cache_url`: optional client cache browser URL.
- `timeout`: optional active timeout in seconds; minimum 60, default 600, maximum 43200.
- `uptime_s`, `files_sent`, `bytes_sent`, `cache_count`, `cache_size`, `open_connections`: optional client counters.
- `events`: optional array of request events. Each event can include `fileid`, `ip`, `bytes`, and `ts`.

`POST /v1/flush`

Requires `HATH_INGEST_TOKEN`. Flushes buffered Durable Object data to D1.

Query parameters:

- `client_ip`: optional target client IP. If omitted, the Worker-derived client IP is used.
- `all=1` or `all=true`: flush all clients instead of one client.

`GET /v1/refresh`

Requires `HATH_READ_TOKEN`. Browser/operator convenience route that triggers a global flush. Equivalent to an internal `POST /flush?all=1`.

`POST /v1/refresh`

Same as `GET /v1/refresh`. Requires `HATH_READ_TOKEN`.

### Read routes

`GET /v1/overview`

Requires `HATH_READ_TOKEN`. Returns global summary, active client count, total requests, and per-client top file/top requester IP.

Query parameters:

- `tz`: optional timezone offset. Values with absolute value `<= 24` are treated as hours; larger values are treated as minutes and clamped to +/- 1440 minutes.

`GET /v1/clients`

Requires `HATH_READ_TOKEN`. Lists client records ordered by `last_seen_ts` descending.

Query parameters:

- `limit`: optional row limit; default 200, maximum 1000.
- `tz`: optional timezone offset.

`GET /v1/top/files`

Requires `HATH_READ_TOKEN`. Lists top requested files for one client.

Query parameters:

- `client_ip` or `name`: one of them is required. If neither resolves, the endpoint returns `missing_client`.
- `limit`: optional row limit; default 50, maximum 500.
- `tz`: optional timezone offset.

`GET /v1/cache/files`

Alias for `GET /v1/top/files`. Requires `HATH_READ_TOKEN` and accepts the same query parameters.

`GET /v1/top/ips`

Requires `HATH_READ_TOKEN`. Lists top requester IPs for one client.

Query parameters:

- `client_ip` or `name`: one of them is required. If neither resolves, the endpoint returns `missing_client`.
- `limit`: optional row limit; default 50, maximum 500.
- `tz`: optional timezone offset.

### Cache browser routes

`GET /cache`

Requires `HATH_READ_TOKEN`. Returns the HTML cache browser UI.

Query parameters:

- `name`: optional initial client name.

`GET /v1/cache`

Alias for `GET /cache`. Requires `HATH_READ_TOKEN`.

`GET /v1/cache/browser`

Alias for `GET /cache`. Requires `HATH_READ_TOKEN`.

`GET /v1/cache/tree`

Requires `HATH_READ_TOKEN`. Proxies the selected H@H client's local cache browser list endpoint and returns directory/file entries.

Query parameters:

- `client_ip`: optional client selector.
- `name`: optional client selector.
- `prefix`: optional lowercase/uppercase hex prefix, 0 to 40 characters. Invalid non-hex prefixes return `invalid_prefix`.
- `limit`: optional row limit; default 500, maximum 1000.
- `offset`: optional pagination offset; default 0.

If neither `client_ip` nor `name` is provided, the newest client with a non-empty `cache_url` is used.

`GET /v1/cache/file`

Requires `HATH_READ_TOKEN`. Proxies one cached file from the selected H@H client and streams it inline.

Query parameters:

- `fileid`: required H@H cache file id matching `<40-hex>-<size>[-<x>-<y>]-<type>`.
- `client_ip`: optional client selector.
- `name`: optional client selector.

`GET /v1/cache/probe`

Requires `HATH_READ_TOKEN`. Tests whether the Worker can reach the selected client's cache browser list endpoint.

Query parameters:

- `client_ip`: optional client selector.
- `name`: optional client selector.

### Internal Durable Object routes

`POST /ingest` and `POST /flush` exist only on `HathStatsDurableObject.fetch()`. They are not public Worker API routes; public callers should use `/v1/ingest` and `/v1/flush`, which perform token validation before forwarding to the Durable Object.

To see the latest buffered stats immediately, run:

```text
POST /v1/flush?all=1
```

then query the read API again.

## Cloudflare Bindings

`wrangler.toml` must contain:

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

Cloudflare recommends `new_sqlite_classes` for new Durable Object namespaces. The migration tag must remain in future deployments; do not remove it after the first deploy.

Secrets:

```text
HATH_INGEST_TOKEN
HATH_READ_TOKEN
```

Set them with:

```powershell
npx wrangler secret put HATH_INGEST_TOKEN
npx wrangler secret put HATH_READ_TOKEN
```

## Deployment

From the `Workers` directory:

```powershell
npx wrangler deploy
```

If deploying from the repository root, pass the config explicitly:

```powershell
npx wrangler deploy --config Workers/wrangler.toml
```

## Smoke Tests

PowerShell aliases `curl` to `Invoke-WebRequest`, so prefer `Invoke-RestMethod` or `curl.exe`.

Ingest test:

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

Expected response:

```json
{
  "ok": true,
  "mode": "durable_object",
  "events": 0,
  "flushed": 1
}
```

Event ingest test:

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

Manual flush:

```powershell
Invoke-RestMethod `
  -Uri "https://<worker-domain>/v1/flush?all=1" `
  -Method Post `
  -Headers @{ Authorization = "Bearer <HATH_INGEST_TOKEN>" }
```

Read back:

```powershell
$readToken = "<HATH_READ_TOKEN>"
$url = "https://<worker-domain>/v1/top/files?name=do-test&token=" + [uri]::EscapeDataString($readToken)
Invoke-RestMethod -Uri $url
```

## Operational Notes

- KV should not be used for ingest buffering. It can hit KV operation limits under high telemetry volume.
- D1 should not be written per event. Always aggregate first.
- Durable Object storage checkpointing is the durability/performance tradeoff knob.
- Read APIs are eventually consistent with ingest because they read D1, not the current DO memory.
- `POST /v1/flush?all=1` is the operator escape hatch when the dashboard needs the freshest possible data.
- If `/v1/ingest` returns `missing_durable_object`, the `HATH_STATS` binding or Durable Object migration is missing.
- If `/v1/ingest` returns `invalid_json`, the request body is malformed. This is common when using PowerShell `curl` instead of `Invoke-RestMethod` or `curl.exe`.
- If read APIs return `401`, verify `HATH_READ_TOKEN`; ingest and read tokens are separate.
