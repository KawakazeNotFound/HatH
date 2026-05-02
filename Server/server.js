const http = require("node:http");
const { URL } = require("node:url");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 8789);
const API_TOKEN = process.env.HATH_API_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const CLIENT_INACTIVE_AFTER_S = 2 * 60 * 60;
const CLIENT_DELETE_AFTER_S = 12 * 60 * 60;

if(!DATABASE_URL) {
	console.error("Missing DATABASE_URL");
	process.exit(1);
}

const pool = new Pool({
	connectionString: DATABASE_URL,
	max: Number(process.env.PG_POOL_MAX || 10),
	idleTimeoutMillis: 30000,
	connectionTimeoutMillis: 5000
});

function pad2(value) {
	return value < 10 ? "0" + value : "" + value;
}

function formatTimestamp(ts, tzOffsetSeconds) {
	if(!ts) {
		return null;
	}

	const date = new Date((Number(ts) + tzOffsetSeconds) * 1000);
	const yyyy = date.getUTCFullYear();
	const mm = pad2(date.getUTCMonth() + 1);
	const dd = pad2(date.getUTCDate());
	const hh = pad2(date.getUTCHours());
	const mi = pad2(date.getUTCMinutes());
	const ss = pad2(date.getUTCSeconds());

	const offsetMinutes = Math.trunc(tzOffsetSeconds / 60);
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absMinutes = Math.abs(offsetMinutes);
	const offH = pad2(Math.floor(absMinutes / 60));
	const offM = pad2(absMinutes % 60);
	return yyyy + "-" + mm + "-" + dd + " " + hh + ":" + mi + ":" + ss + " UTC" + sign + offH + ":" + offM;
}

function getTzOffsetSeconds(url) {
	const tz = url.searchParams.get("tz");
	if(!tz) {
		return 0;
	}

	const num = Number(tz);
	if(Number.isNaN(num)) {
		return 0;
	}

	if(Math.abs(num) <= 24) {
		return Math.trunc(num * 3600);
	}

	const minutes = Math.max(-1440, Math.min(1440, Math.trunc(num)));
	return minutes * 60;
}

function getFileExtension(type) {
	if(type === "wbp") {
		return "webp";
	}
	if(type === "wbm") {
		return "webm";
	}
	if(type === "avf") {
		return "avif";
	}
	return type || "";
}

function getMimeType(type) {
	switch(type) {
		case "jpg": return "image/jpeg";
		case "png": return "image/png";
		case "gif": return "image/gif";
		case "mp4": return "video/mp4";
		case "wbm": return "video/webm";
		case "wbp": return "image/webp";
		case "avf": return "image/avif";
		case "jxl": return "image/jxl";
		default: return "application/octet-stream";
	}
}

function addFileMetadata(row) {
	const match = String(row.fileid || "").match(/^([a-f0-9]{40})-\d+(?:-\d+-\d+)?-(jpg|png|gif|mp4|wbm|wbp|avf|jxl)$/);
	if(!match) {
		row.display_name = row.fileid;
		row.extension = "";
		row.mime = "application/octet-stream";
		return row;
	}

	row.extension = getFileExtension(match[2]);
	row.mime = getMimeType(match[2]);
	row.display_name = match[1] + "." + row.extension;
	return row;
}

function asNumber(value) {
	if(value === null || value === undefined) {
		return 0;
	}
	return Number(value);
}

function asArray(value) {
	if(Array.isArray(value)) {
		return value;
	}
	if(!value) {
		return [];
	}
	if(typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		}
		catch(e) {
			return [];
		}
	}
	return [];
}

function normalizeClient(row) {
	return {
		client_ip: row.client_ip,
		name: row.name || "",
		cache_url: row.cache_url || "",
		last_seen_ts: asNumber(row.last_seen_ts),
		timeout_s: asNumber(row.timeout_s),
		uptime_s: asNumber(row.uptime_s),
		files_sent: asNumber(row.files_sent),
		bytes_sent: asNumber(row.bytes_sent),
		cache_count: asNumber(row.cache_count),
		cache_size: asNumber(row.cache_size),
		open_connections: asNumber(row.open_connections)
	};
}

function json(res, status, data) {
	const body = JSON.stringify(data);
	res.writeHead(status || 200, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
			if(body.length > 10 * 1024 * 1024) {
				reject(new Error("request_body_too_large"));
				req.destroy();
			}
		});
		req.on("end", () => {
			if(!body) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(body));
			}
			catch(e) {
				reject(new Error("invalid_json"));
			}
		});
		req.on("error", reject);
	});
}

function requireAuth(req) {
	if(!API_TOKEN) {
		return true;
	}

	const auth = req.headers.authorization || "";
	const headerToken = req.headers["x-hath-api-token"] || "";
	return auth === "Bearer " + API_TOKEN || headerToken === API_TOKEN;
}

async function upsertClient(row) {
	await pool.query(
		"INSERT INTO clients (client_ip, name, cache_url, last_seen_ts, timeout_s, uptime_s, files_sent, bytes_sent, cache_count, cache_size, open_connections) " +
		"VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) " +
		"ON CONFLICT(client_ip) DO UPDATE SET name=excluded.name, cache_url=CASE WHEN excluded.cache_url <> '' THEN excluded.cache_url ELSE clients.cache_url END, last_seen_ts=excluded.last_seen_ts, timeout_s=excluded.timeout_s, uptime_s=excluded.uptime_s, files_sent=excluded.files_sent, bytes_sent=excluded.bytes_sent, cache_count=excluded.cache_count, cache_size=excluded.cache_size, open_connections=excluded.open_connections",
		[
			String(row.client_ip || ""),
			String(row.name || ""),
			String(row.cache_url || ""),
			asNumber(row.last_seen_ts),
			asNumber(row.timeout_s),
			asNumber(row.uptime_s),
			asNumber(row.files_sent),
			asNumber(row.bytes_sent),
			asNumber(row.cache_count),
			asNumber(row.cache_size),
			asNumber(row.open_connections)
		]
	);
}

function statEntries(rows) {
	return Object.entries(rows || {}).filter(([key]) => key);
}

async function bulkUpsertStats(client, table, clientIp, entries) {
	if(entries.length === 0) {
		return 0;
	}

	const keyColumn = table === "file_stats" ? "fileid" : "requester_ip";
	for(let offset = 0; offset < entries.length; offset += 500) {
		const chunk = entries.slice(offset, offset + 500);
		const values = [];
		const placeholders = chunk.map(([key, row], index) => {
			const base = index * 5;
			values.push(clientIp, key, asNumber(row.request_count), asNumber(row.bytes_sent), asNumber(row.last_seen_ts));
			return "($" + (base + 1) + ",$" + (base + 2) + ",$" + (base + 3) + ",$" + (base + 4) + ",$" + (base + 5) + ")";
		}).join(",");

		await client.query(
			"INSERT INTO " + table + " (client_ip, " + keyColumn + ", request_count, bytes_sent, last_seen_ts) VALUES " + placeholders + " " +
			"ON CONFLICT(client_ip, " + keyColumn + ") DO UPDATE SET request_count=" + table + ".request_count+excluded.request_count, bytes_sent=" + table + ".bytes_sent+excluded.bytes_sent, last_seen_ts=GREATEST(" + table + ".last_seen_ts, excluded.last_seen_ts)",
			values
		);
	}

	return entries.length;
}

async function upsertAggregate(body) {
	const clientIp = String(body.client_ip || "");
	if(!clientIp) {
		const err = new Error("missing_client_ip");
		err.status = 400;
		throw err;
	}

	const fileEntries = statEntries(body.files);
	const ipEntries = statEntries(body.ips);
	const totalRequests = fileEntries.reduce((sum, [, row]) => sum + asNumber(row.request_count), 0);
	const totalBytes = fileEntries.reduce((sum, [, row]) => sum + asNumber(row.bytes_sent), 0);
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await bulkUpsertStats(client, "file_stats", clientIp, fileEntries);
		await bulkUpsertStats(client, "ip_stats", clientIp, ipEntries);
		if(totalRequests > 0 || totalBytes > 0) {
			await client.query(
				"INSERT INTO client_totals (client_ip, total_requests, bytes_sent) VALUES ($1,$2,$3) " +
				"ON CONFLICT(client_ip) DO UPDATE SET total_requests=client_totals.total_requests+excluded.total_requests, bytes_sent=client_totals.bytes_sent+excluded.bytes_sent",
				[clientIp, totalRequests, totalBytes]
			);
		}
		await client.query("COMMIT");
		return { stat_writes: fileEntries.length + ipEntries.length };
	}
	catch(e) {
		await client.query("ROLLBACK");
		throw e;
	}
	finally {
		client.release();
	}
}

async function deleteExpiredClients(now) {
	const cutoff = now - CLIENT_DELETE_AFTER_S;
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await client.query("SELECT client_ip FROM clients WHERE last_seen_ts <= $1", [cutoff]);
		const clientIps = result.rows.map((row) => row.client_ip).filter(Boolean);
		if(clientIps.length === 0) {
			await client.query("COMMIT");
			return 0;
		}

		await client.query("DELETE FROM file_stats WHERE client_ip = ANY($1::text[])", [clientIps]);
		await client.query("DELETE FROM ip_stats WHERE client_ip = ANY($1::text[])", [clientIps]);
		await client.query("DELETE FROM client_totals WHERE client_ip = ANY($1::text[])", [clientIps]);
		await client.query("DELETE FROM clients WHERE client_ip = ANY($1::text[])", [clientIps]);
		await client.query("COMMIT");
		return clientIps.length;
	}
	catch(e) {
		await client.query("ROLLBACK");
		throw e;
	}
	finally {
		client.release();
	}
}

async function resolveClient(url) {
	await deleteExpiredClients(Math.floor(Date.now() / 1000));

	const clientIp = url.searchParams.get("client_ip");
	const name = url.searchParams.get("name");
	let result;
	if(clientIp) {
		result = await pool.query("SELECT client_ip, name, cache_url FROM clients WHERE client_ip = $1 LIMIT 1", [clientIp]);
	}
	else if(name) {
		result = await pool.query("SELECT client_ip, name, cache_url FROM clients WHERE name = $1 ORDER BY last_seen_ts DESC LIMIT 1", [name]);
	}
	else {
		result = await pool.query("SELECT client_ip, name, cache_url FROM clients WHERE cache_url IS NOT NULL AND cache_url <> '' ORDER BY last_seen_ts DESC LIMIT 1");
	}

	return result.rows[0] || null;
}

async function overview(url) {
	const now = Math.floor(Date.now() / 1000);
	await deleteExpiredClients(now);

	const tzOffsetSeconds = getTzOffsetSeconds(url);
	const result = await pool.query(
		"SELECT c.*, COALESCE(ct.total_requests, 0) AS total_requests, " +
		"tf.top_files, ti.top_ips " +
		"FROM clients c " +
		"LEFT JOIN client_totals ct ON ct.client_ip = c.client_ip " +
		"LEFT JOIN LATERAL (" +
		"SELECT json_agg(json_build_object('fileid', fileid, 'request_count', request_count, 'bytes_sent', bytes_sent, 'last_seen_ts', last_seen_ts) ORDER BY request_count DESC, bytes_sent DESC) AS top_files " +
		"FROM (SELECT fileid, request_count, bytes_sent, last_seen_ts FROM file_stats WHERE client_ip = c.client_ip ORDER BY request_count DESC, bytes_sent DESC LIMIT 10) ranked_files" +
		") tf ON true " +
		"LEFT JOIN LATERAL (" +
		"SELECT json_agg(json_build_object('ip', requester_ip, 'request_count', request_count, 'bytes_sent', bytes_sent, 'last_seen_ts', last_seen_ts) ORDER BY request_count DESC, bytes_sent DESC) AS top_ips " +
		"FROM (SELECT requester_ip, request_count, bytes_sent, last_seen_ts FROM ip_stats WHERE client_ip = c.client_ip ORDER BY request_count DESC, bytes_sent DESC LIMIT 10) ranked_ips" +
		") ti ON true " +
		"ORDER BY c.last_seen_ts DESC"
	);

	const clientsByName = {};
	let totalRequests = 0;
	for(const row of result.rows) {
		const active = asNumber(row.last_seen_ts) >= (now - CLIENT_INACTIVE_AFTER_S);
		const bytesSent = asNumber(row.bytes_sent);
		const uptime = asNumber(row.uptime_s);
		const avgSpeed = uptime > 0 ? bytesSent / uptime : 0;
		const timeout = Math.min(asNumber(row.timeout_s || 600), 43200);
		const topFiles = asArray(row.top_files).map((file) => {
			const topFile = addFileMetadata({
				fileid: file.fileid,
				request_count: asNumber(file.request_count),
				bytes_sent: asNumber(file.bytes_sent),
				last_seen_ts: asNumber(file.last_seen_ts)
			});
			topFile.last_seen = formatTimestamp(topFile.last_seen_ts, tzOffsetSeconds);
			return topFile;
		});
		const topIps = asArray(row.top_ips).map((ip) => ({
			ip: ip.ip,
			request_count: asNumber(ip.request_count),
			bytes_sent: asNumber(ip.bytes_sent),
			last_seen_ts: asNumber(ip.last_seen_ts),
			last_seen: formatTimestamp(ip.last_seen_ts, tzOffsetSeconds)
		}));
		const topFile = topFiles[0] || null;
		const topIp = topIps[0] || null;

		const name = row.name && row.name.length > 0 ? row.name : "client";
		let key = name;
		let suffix = 2;
		while(Object.prototype.hasOwnProperty.call(clientsByName, key)) {
			key = name + "#" + suffix;
			suffix++;
		}

		const clientEntry = {
			name: key,
			cache_url: row.cache_url || null,
			last_seen_ts: asNumber(row.last_seen_ts),
			last_seen: formatTimestamp(row.last_seen_ts, tzOffsetSeconds),
			timeout_s: timeout,
			active: active,
			uptime_s: asNumber(row.uptime_s),
			files_sent: asNumber(row.files_sent),
			bytes_sent: asNumber(row.bytes_sent),
			avg_speed: avgSpeed,
			cache_count: asNumber(row.cache_count),
			cache_size: asNumber(row.cache_size),
			open_connections: asNumber(row.open_connections),
			total_requests: asNumber(row.total_requests),
			top_file: topFile,
			top_files: topFiles,
			top_ip: topIp,
			top_ips: topIps
		};

		clientsByName[key] = clientEntry;
		totalRequests += clientEntry.total_requests;
	}

	const activeCount = Object.values(clientsByName).filter((client) => client.active).length;
	return {
		client_count: Object.keys(clientsByName).length,
		active_client_count: activeCount,
		total_requests: totalRequests,
		clients: clientsByName
	};
}

async function clients(url) {
	await deleteExpiredClients(Math.floor(Date.now() / 1000));

	const tzOffsetSeconds = getTzOffsetSeconds(url);
	const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
	const result = await pool.query("SELECT * FROM clients ORDER BY last_seen_ts DESC LIMIT $1", [limit]);
	return {
		clients: result.rows.map((row) => {
			const client = normalizeClient(row);
			client.last_seen = formatTimestamp(client.last_seen_ts, tzOffsetSeconds);
			return client;
		})
	};
}

async function topFiles(url) {
	const tzOffsetSeconds = getTzOffsetSeconds(url);
	if(!url.searchParams.get("client_ip") && !url.searchParams.get("name")) {
		const err = new Error("missing_client");
		err.status = 400;
		throw err;
	}

	const client = await resolveClient(url);
	if(!client) {
		const err = new Error("missing_client");
		err.status = 400;
		throw err;
	}

	const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
	const result = await pool.query("SELECT fileid, request_count, bytes_sent, last_seen_ts FROM file_stats WHERE client_ip = $1 ORDER BY request_count DESC LIMIT $2", [client.client_ip, limit]);
	return {
		files: result.rows.map((row) => {
			const file = addFileMetadata({
				fileid: row.fileid,
				request_count: asNumber(row.request_count),
				bytes_sent: asNumber(row.bytes_sent),
				last_seen_ts: asNumber(row.last_seen_ts)
			});
			file.last_seen = formatTimestamp(file.last_seen_ts, tzOffsetSeconds);
			return file;
		})
	};
}

async function topIps(url) {
	const tzOffsetSeconds = getTzOffsetSeconds(url);
	if(!url.searchParams.get("client_ip") && !url.searchParams.get("name")) {
		const err = new Error("missing_client");
		err.status = 400;
		throw err;
	}

	const client = await resolveClient(url);
	if(!client) {
		const err = new Error("missing_client");
		err.status = 400;
		throw err;
	}

	const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
	const result = await pool.query("SELECT requester_ip, request_count, bytes_sent, last_seen_ts FROM ip_stats WHERE client_ip = $1 ORDER BY request_count DESC LIMIT $2", [client.client_ip, limit]);
	return {
		ips: result.rows.map((row) => ({
			requester_ip: row.requester_ip,
			request_count: asNumber(row.request_count),
			bytes_sent: asNumber(row.bytes_sent),
			last_seen_ts: asNumber(row.last_seen_ts),
			last_seen: formatTimestamp(row.last_seen_ts, tzOffsetSeconds)
		}))
	};
}

async function route(req, res) {
	const url = new URL(req.url, "http://localhost");
	if(req.method === "GET" && url.pathname === "/health") {
		json(res, 200, { ok: true });
		return;
	}

	if(!requireAuth(req)) {
		json(res, 401, { error: "unauthorized" });
		return;
	}

	if(req.method === "POST" && url.pathname === "/v1/clients/upsert") {
		await upsertClient(await readJson(req));
		json(res, 200, { ok: true, client_writes: 1 });
		return;
	}

	if(req.method === "POST" && url.pathname === "/v1/stats/aggregate") {
		json(res, 200, Object.assign({ ok: true }, await upsertAggregate(await readJson(req))));
		return;
	}

	if(req.method === "GET" && url.pathname === "/v1/overview") {
		json(res, 200, await overview(url));
		return;
	}

	if(req.method === "GET" && url.pathname === "/v1/clients") {
		json(res, 200, await clients(url));
		return;
	}

	if(req.method === "GET" && (url.pathname === "/v1/top/files" || url.pathname === "/v1/cache/files")) {
		json(res, 200, await topFiles(url));
		return;
	}

	if(req.method === "GET" && url.pathname === "/v1/top/ips") {
		json(res, 200, await topIps(url));
		return;
	}

	if(req.method === "GET" && url.pathname === "/v1/client/resolve") {
		const client = await resolveClient(url);
		if(!client) {
			json(res, 404, { error: "missing_client" });
			return;
		}
		json(res, 200, client);
		return;
	}

	json(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
	route(req, res).catch((err) => {
		const status = err.status || 500;
		json(res, status, { error: err.message || "internal_error" });
	});
});

server.listen(PORT, () => {
	console.log("H@H stats API listening on port " + PORT);
});
