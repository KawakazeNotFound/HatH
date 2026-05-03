# H@H Stats API

Self-hosted HTTP API for the Worker to store stats in PostgreSQL instead of D1.

## Database

Create a database and apply the schema:

```bash
createdb hath
psql "$DATABASE_URL" -f schema.sql
```

Required environment variables:

```bash
DATABASE_URL=postgres://hath_user:password@127.0.0.1:5432/hath
HATH_API_TOKEN=change-this-token
PORT=8789
```

Install and run:

```bash
npm install
npm start
```

Health check:

```bash
curl http://127.0.0.1:8789/health
```

## Worker configuration

Set the server URL as a Worker variable and the shared API token as a Worker secret:

```bash
npx wrangler secret put HATH_API_TOKEN --config Workers/wrangler.toml
```

In `Workers/wrangler.toml`, add:

```toml
[vars]
HATH_API_URL = "https://your-api.example.com"
```

When `HATH_API_URL` is present, stats reads and writes go to this API. If it is absent, the Worker keeps using D1.

## Endpoints

These endpoints are intended for the Worker, not public browser use. All `/v1/*` routes require `Authorization: Bearer <HATH_API_TOKEN>` when `HATH_API_TOKEN` is set on the server.

- `POST /v1/clients/upsert`
- `POST /v1/stats/aggregate`
- `DELETE /v1/clients?client_ip=<ip>`
- `DELETE /v1/clients?name=<name>`
- `GET /v1/overview`
- `GET /v1/clients`
- `GET /v1/top/files`
- `GET /v1/top/ips`
- `GET /v1/client/resolve`

`POST /v1/clients/upsert` and `POST /v1/stats/aggregate` identify the client only from the `X-Hath-Client-IP` header set by the Worker. A `client_ip` field in the JSON body is ignored.

## Existing D1 data

If you import old D1 rows into PostgreSQL, rebuild `client_totals` after importing `file_stats`:

```sql
INSERT INTO client_totals (client_ip, total_requests, bytes_sent)
SELECT client_ip, SUM(request_count), SUM(bytes_sent)
FROM file_stats
GROUP BY client_ip
ON CONFLICT (client_ip) DO UPDATE
SET total_requests = EXCLUDED.total_requests,
	bytes_sent = EXCLUDED.bytes_sent;
```
