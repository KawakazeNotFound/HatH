import dashboardHtmlRaw from "./dashboard.html";

const JSON_HEADERS = {"Content-Type": "application/json"};
const HTML_HEADERS = {"Content-Type": "text/html; charset=utf-8"};
const STATS_FLUSH_INTERVAL_S = 3600;
const D1_BATCH_SIZE = 50;
const STATS_API_BATCH_SIZE = 500;
const DO_CHECKPOINT_INTERVAL_S = 60;
const DO_CHECKPOINT_EVENT_LIMIT = 1000;
const CLIENT_INACTIVE_AFTER_S = 2 * 60 * 60;
const CLIENT_DELETE_AFTER_S = 12 * 60 * 60;

function jsonResponse(data, status) {
	return new Response(JSON.stringify(data), { status: status || 200, headers: JSON_HEADERS });
}

function htmlResponse(body, status) {
	return new Response(body, { status: status || 200, headers: HTML_HEADERS });
}

function extractToken(request) {
	const auth = request.headers.get("Authorization");
	if(auth && auth.startsWith("Bearer ")) {
		return auth.substring(7);
	}

	const headerToken = request.headers.get("X-Auth-Token");
	return headerToken || null;
}

function requireAuth(request, env, envKey, allowQueryToken) {
	const required = env[envKey];
	if(!required) {
		return null;
	}

	let token = extractToken(request);
	if(!token && allowQueryToken) {
		const url = new URL(request.url);
		token = url.searchParams.get("token");
	}

	if(token !== required) {
		return jsonResponse({ error: "unauthorized" }, 401);
	}

	return null;
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

function pad2(value) {
	return value < 10 ? "0" + value : "" + value;
}

function formatTimestamp(ts, tzOffsetSeconds) {
	if(!ts) {
		return null;
	}

	const date = new Date((ts + tzOffsetSeconds) * 1000);
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

function getReadTokenParam(request) {
	const url = new URL(request.url);
	const token = url.searchParams.get("token");
	return token ? "&token=" + encodeURIComponent(token) : "";
}

function jsString(value) {
	return JSON.stringify(String(value || ""));
}

function parseCacheUrl(cacheUrl) {
	if(!cacheUrl) {
		return null;
	}

	try {
		const url = new URL(cacheUrl);
		let token = url.searchParams.get("token") || "";
		for(const part of url.pathname.split("/")) {
			if(part.startsWith("token=")) {
				token = part.substring(6);
			}
		}

		return {
			origin: url.origin,
			token: token
		};
	}
	catch(e) {
		return null;
	}
}

function buildClientPath(cacheRef, action, params) {
	const parts = [cacheRef.origin, "local", "cache"];
	if(action) {
		parts.push(action);
	}
	if(params) {
		parts.push(params);
	}

	let url = parts.join("/");
	if(cacheRef.token) {
		url += (action === "list" && params ? ";" : "/") + "token=" + encodeURIComponent(cacheRef.token);
	}
	return url;
}

function getClientIp(request) {
	const cfIp = request.headers.get("cf-connecting-ip");
	if(cfIp && cfIp.length > 0) {
		return cfIp;
	}

	const xff = request.headers.get("x-forwarded-for");
	if(xff && xff.length > 0) {
		return xff.split(",")[0].trim();
	}

	const realIp = request.headers.get("x-real-ip");
	return realIp || "unknown";
}

function hasStatsApi(env) {
	return !!(env.HATH_API_URL && String(env.HATH_API_URL).length > 0);
}

function hasStatsStore(env) {
	return hasStatsApi(env) || !!env.HATH_DB;
}

function statsStoreMissingResponse() {
	return jsonResponse({ error: "missing_stats_store" }, 500);
}

function getStatsApiUrl(env, path) {
	const base = String(env.HATH_API_URL || "").replace(/\/+$/, "");
	return base + path;
}

function getStatsApiHeaders(env) {
	const headers = new Headers({ "Accept": "application/json" });
	const token = env.HATH_API_TOKEN || "";
	if(token) {
		headers.set("Authorization", "Bearer " + token);
	}
	return headers;
}

async function callStatsApi(env, path, options) {
	const headers = getStatsApiHeaders(env);
	let body = null;
	if(options && options.body !== undefined) {
		headers.set("Content-Type", "application/json");
		body = JSON.stringify(options.body);
	}

	const res = await fetch(getStatsApiUrl(env, path), {
		method: (options && options.method) || "GET",
		headers: headers,
		body: body
	});

	const text = await res.text();
	let data = {};
	if(text) {
		try {
			data = JSON.parse(text);
		}
		catch(e) {
			data = { error: "invalid_api_json", detail: text.substring(0, 500) };
		}
	}

	if(!res.ok) {
		const err = new Error(data.error || "stats_api_error");
		err.status = res.status;
		err.data = data;
		throw err;
	}

	return data;
}

async function proxyStatsApiJson(env, path) {
	try {
		const data = await callStatsApi(env, path);
		return jsonResponse(data);
	}
	catch(e) {
		return jsonResponse(e.data || { error: e.message || "stats_api_error" }, e.status || 502);
	}
}

function copyQuery(request, path, names) {
	const input = new URL(request.url);
	const output = new URL("https://hath.internal" + path);
	for(const name of names) {
		const value = input.searchParams.get(name);
		if(value !== null) {
			output.searchParams.set(name, value);
		}
	}
	return output.pathname + output.search;
}

function requireStatsDo(env) {
	return env.HATH_STATS ? null : jsonResponse({ error: "missing_durable_object" }, 500);
}

function getStatsDo(env) {
	const id = env.HATH_STATS.idFromName("global");
	return env.HATH_STATS.get(id);
}

function getInternalStatsRequest(request, path, clientIp) {
	const inputUrl = new URL(request.url);
	const url = new URL("https://hath.internal" + path);
	url.search = inputUrl.search;

	const headers = new Headers(request.headers);
	headers.set("X-Hath-Client-IP", clientIp);
	return new Request(url.toString(), {
		method: request.method,
		headers: headers,
		body: request.body
	});
}

async function forwardToStatsDo(request, env, path) {
	const error = requireStatsDo(env);
	if(error) {
		return error;
	}

	const stub = getStatsDo(env);
	return stub.fetch(getInternalStatsRequest(request, path, getClientIp(request)));
}

function getHourBucket(ts) {
	return Math.floor(Number(ts || 0) / STATS_FLUSH_INTERVAL_S) * STATS_FLUSH_INTERVAL_S;
}

function addAggRow(map, key, bytes, ts) {
	if(!key) {
		return;
	}

	const current = map[key] || { request_count: 0, bytes_sent: 0, last_seen_ts: 0 };
	current.request_count += 1;
	current.bytes_sent += Number(bytes || 0);
	current.last_seen_ts = Math.max(Number(current.last_seen_ts || 0), Number(ts || 0));
	map[key] = current;
}

function bindStatStatement(env, table, clientIp, key, row) {
	if(table === "file") {
		return env.HATH_DB.prepare(
			"INSERT INTO file_stats (client_ip, fileid, request_count, bytes_sent, last_seen_ts) VALUES (?, ?, ?, ?, ?) " +
			"ON CONFLICT(client_ip, fileid) DO UPDATE SET request_count=request_count+excluded.request_count, bytes_sent=bytes_sent+excluded.bytes_sent, last_seen_ts=MAX(file_stats.last_seen_ts, excluded.last_seen_ts)"
		).bind(clientIp, key, row.request_count, row.bytes_sent, row.last_seen_ts);
	}

	return env.HATH_DB.prepare(
		"INSERT INTO ip_stats (client_ip, requester_ip, request_count, bytes_sent, last_seen_ts) VALUES (?, ?, ?, ?, ?) " +
		"ON CONFLICT(client_ip, requester_ip) DO UPDATE SET request_count=request_count+excluded.request_count, bytes_sent=bytes_sent+excluded.bytes_sent, last_seen_ts=MAX(ip_stats.last_seen_ts, excluded.last_seen_ts)"
	).bind(clientIp, key, row.request_count, row.bytes_sent, row.last_seen_ts);
}

async function flushStatsAggregate(env, clientIp, aggregate) {
	if(!aggregate || !aggregate.client_ip) {
		return 0;
	}

	if(hasStatsApi(env)) {
		let written = 0;
		const fileIds = Object.keys(aggregate.files || {});
		for(let i = 0; i < fileIds.length; i += STATS_API_BATCH_SIZE) {
			const files = {};
			for(const fileId of fileIds.slice(i, i + STATS_API_BATCH_SIZE)) {
				files[fileId] = aggregate.files[fileId];
			}
			const result = await callStatsApi(env, "/v1/stats/aggregate", {
				method: "POST",
				body: { client_ip: clientIp, files: files, ips: {} }
			});
			written += Number(result.stat_writes || 0);
		}

		const ips = Object.keys(aggregate.ips || {});
		for(let i = 0; i < ips.length; i += STATS_API_BATCH_SIZE) {
			const ipRows = {};
			for(const ip of ips.slice(i, i + STATS_API_BATCH_SIZE)) {
				ipRows[ip] = aggregate.ips[ip];
			}
			const result = await callStatsApi(env, "/v1/stats/aggregate", {
				method: "POST",
				body: { client_ip: clientIp, files: {}, ips: ipRows }
			});
			written += Number(result.stat_writes || 0);
		}

		return written;
	}

	const stmts = [];
	for(const fileId of Object.keys(aggregate.files || {})) {
		stmts.push(bindStatStatement(env, "file", clientIp, fileId, aggregate.files[fileId]));
	}

	for(const ip of Object.keys(aggregate.ips || {})) {
		stmts.push(bindStatStatement(env, "ip", clientIp, ip, aggregate.ips[ip]));
	}

	for(let i = 0; i < stmts.length; i += D1_BATCH_SIZE) {
		await env.HATH_DB.batch(stmts.slice(i, i + D1_BATCH_SIZE));
	}

	return stmts.length;
}

async function queueStatsAggregate(env, stats, clientIp, events, now) {
	const currentBucket = getHourBucket(now);
	let aggregate = stats.get(clientIp);
	let flushed = 0;

	if(aggregate && Number(aggregate.bucket_start_ts || 0) < currentBucket) {
		flushed = await flushStatsAggregate(env, clientIp, aggregate);
		aggregate = null;
	}

	if(!aggregate || Number(aggregate.bucket_start_ts || 0) !== currentBucket) {
		aggregate = {
			client_ip: clientIp,
			bucket_start_ts: currentBucket,
			files: {},
			ips: {}
		};
	}

	for(const ev of events) {
		const fileId = String(ev.fileid || "");
		const ip = String(ev.ip || "");
		const bytes = Number(ev.bytes || 0);
		const evTs = Number(ev.ts || now);

		addAggRow(aggregate.files, fileId, bytes, evTs);
		addAggRow(aggregate.ips, ip, bytes, evTs);
	}

	stats.set(clientIp, aggregate);
	return flushed;
}

function buildClientRecord(body, clientIp, now) {
	let timeout = Number(body.timeout || 0);
	if(!timeout || timeout < 60) {
		timeout = 600;
	}
	timeout = Math.min(timeout, 43200);

	return {
		client_ip: clientIp,
		name: String(body.name || ""),
		cache_url: String(body.cache_url || ""),
		last_seen_ts: now,
		timeout_s: timeout,
		uptime_s: Number(body.uptime_s || 0),
		files_sent: Number(body.files_sent || 0),
		bytes_sent: Number(body.bytes_sent || 0),
		cache_count: Number(body.cache_count || 0),
		cache_size: Number(body.cache_size || 0),
		open_connections: Number(body.open_connections || 0)
	};
}

async function writeClientRecord(env, row) {
	if(hasStatsApi(env)) {
		await callStatsApi(env, "/v1/clients/upsert", {
			method: "POST",
			body: row
		});
		return;
	}

	await env.HATH_DB.prepare(
		"INSERT INTO clients (client_ip, name, cache_url, last_seen_ts, timeout_s, uptime_s, files_sent, bytes_sent, cache_count, cache_size, open_connections) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
		"ON CONFLICT(client_ip) DO UPDATE SET name=excluded.name, cache_url=CASE WHEN excluded.cache_url != '' THEN excluded.cache_url ELSE clients.cache_url END, last_seen_ts=excluded.last_seen_ts, timeout_s=excluded.timeout_s, uptime_s=excluded.uptime_s, files_sent=excluded.files_sent, bytes_sent=excluded.bytes_sent, cache_count=excluded.cache_count, cache_size=excluded.cache_size, open_connections=excluded.open_connections"
	).bind(
		row.client_ip,
		row.name,
		row.cache_url,
		row.last_seen_ts,
		row.timeout_s,
		row.uptime_s,
		row.files_sent,
		row.bytes_sent,
		row.cache_count,
		row.cache_size,
		row.open_connections
	).run();
}

async function queueClientRecord(env, clients, row) {
	const cached = clients.get(row.client_ip);
	const currentBucket = getHourBucket(row.last_seen_ts);

	if(!cached || Number(cached.bucket_start_ts || 0) < currentBucket) {
		if(cached && cached.row) {
			await writeClientRecord(env, cached.row);
		}
		else {
			await writeClientRecord(env, row);
		}

		clients.set(row.client_ip, {
			bucket_start_ts: currentBucket,
			row: row
		});
		return 1;
	}

	cached.row = row;
	clients.set(row.client_ip, cached);
	return 0;
}

async function deleteExpiredClients(env, now) {
	const cutoff = now - CLIENT_DELETE_AFTER_S;
	await env.HATH_DB.batch([
		env.HATH_DB.prepare("DELETE FROM file_stats WHERE client_ip IN (SELECT client_ip FROM clients WHERE last_seen_ts <= ?)").bind(cutoff),
		env.HATH_DB.prepare("DELETE FROM ip_stats WHERE client_ip IN (SELECT client_ip FROM clients WHERE last_seen_ts <= ?)").bind(cutoff),
		env.HATH_DB.prepare("DELETE FROM clients WHERE last_seen_ts <= ?").bind(cutoff)
	]);
}

async function handleIngest(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}
	return forwardToStatsDo(request, env, "/ingest");
}

async function handleFlush(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}
	return forwardToStatsDo(request, env, "/flush");
}

async function handleRefresh(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}

	const url = new URL(request.url);
	url.searchParams.set("all", "1");
	const refreshRequest = new Request(url.toString(), {
		method: "POST",
		headers: request.headers
	});
	return forwardToStatsDo(refreshRequest, env, "/flush");
}

async function handleOverview(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}

	if(hasStatsApi(env)) {
		return proxyStatsApiJson(env, copyQuery(request, "/v1/overview", ["tz"]));
	}

	const now = Math.floor(Date.now() / 1000);
	await deleteExpiredClients(env, now);

	const tzOffsetSeconds = getTzOffsetSeconds(new URL(request.url));
	const res = await env.HATH_DB.prepare(
		"SELECT client_ip, name, cache_url, last_seen_ts, timeout_s, uptime_s, files_sent, bytes_sent, cache_count, cache_size, open_connections, " +
		"(SELECT SUM(request_count) FROM file_stats f WHERE f.client_ip = c.client_ip) AS total_requests " +
		"FROM clients c ORDER BY last_seen_ts DESC"
	).all();

	const clientsByName = {};
	let totalRequests = 0;
	for(const row of (res.results || [])) {
		const active = Number(row.last_seen_ts || 0) >= (now - CLIENT_INACTIVE_AFTER_S);
		const bytesSent = Number(row.bytes_sent || 0);
		const uptime = Number(row.uptime_s || 0);
		const avgSpeed = uptime > 0 ? bytesSent / uptime : 0;
		const timeout = Math.min(Number(row.timeout_s || 600), 43200);
		const clientIp = row.client_ip;
		let topFile = null;
		let topIp = null;

		if(clientIp) {
			const topFileRes = await env.HATH_DB.prepare(
				"SELECT fileid, request_count, bytes_sent, last_seen_ts FROM file_stats WHERE client_ip = ? ORDER BY request_count DESC, bytes_sent DESC LIMIT 1"
			).bind(clientIp).all();
			if(topFileRes.results && topFileRes.results.length > 0) {
				topFile = topFileRes.results[0];
				addFileMetadata(topFile);
				topFile.last_seen = formatTimestamp(topFile.last_seen_ts, tzOffsetSeconds);
			}

			const topIpRes = await env.HATH_DB.prepare(
				"SELECT requester_ip AS ip, request_count, bytes_sent, last_seen_ts FROM ip_stats WHERE client_ip = ? ORDER BY request_count DESC, bytes_sent DESC LIMIT 1"
			).bind(clientIp).all();
			if(topIpRes.results && topIpRes.results.length > 0) {
				topIp = topIpRes.results[0];
				topIp.last_seen = formatTimestamp(topIp.last_seen_ts, tzOffsetSeconds);
			}
		}

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
			last_seen_ts: row.last_seen_ts,
			last_seen: formatTimestamp(row.last_seen_ts, tzOffsetSeconds),
			timeout_s: timeout,
			active: active,
			uptime_s: row.uptime_s || 0,
			files_sent: row.files_sent || 0,
			bytes_sent: row.bytes_sent || 0,
			avg_speed: avgSpeed,
			cache_count: row.cache_count || 0,
			cache_size: row.cache_size || 0,
			open_connections: row.open_connections || 0,
			total_requests: row.total_requests || 0,
			top_file: topFile,
			top_ip: topIp
		};

		clientsByName[key] = clientEntry;
		totalRequests += clientEntry.total_requests;
	}

	const activeCount = Object.values(clientsByName).filter((c) => c.active).length;
	return jsonResponse({
		client_count: Object.keys(clientsByName).length,
		active_client_count: activeCount,
		total_requests: totalRequests,
		clients: clientsByName
	});
}

async function handleClients(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}

	if(hasStatsApi(env)) {
		return proxyStatsApiJson(env, copyQuery(request, "/v1/clients", ["limit", "tz"]));
	}

	const url = new URL(request.url);
	await deleteExpiredClients(env, Math.floor(Date.now() / 1000));

	const tzOffsetSeconds = getTzOffsetSeconds(url);
	const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
	const res = await env.HATH_DB.prepare("SELECT * FROM clients ORDER BY last_seen_ts DESC LIMIT ?").bind(limit).all();
	const clients = (res.results || []).map((row) => {
		row.last_seen = formatTimestamp(row.last_seen_ts, tzOffsetSeconds);
		return row;
	});
	return jsonResponse({ clients: clients });
}

async function handleTopFiles(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}

	if(hasStatsApi(env)) {
		return proxyStatsApiJson(env, copyQuery(request, "/v1/top/files", ["client_ip", "name", "limit", "tz"]));
	}

	const url = new URL(request.url);
	const tzOffsetSeconds = getTzOffsetSeconds(url);
	let clientIp = url.searchParams.get("client_ip");
	const name = url.searchParams.get("name");
	if(!clientIp && name) {
		const ipRes = await env.HATH_DB.prepare("SELECT client_ip FROM clients WHERE name = ? ORDER BY last_seen_ts DESC LIMIT 1").bind(name).all();
		clientIp = ipRes.results && ipRes.results[0] ? ipRes.results[0].client_ip : null;
	}
	if(!clientIp) {
		return jsonResponse({ error: "missing_client" }, 400);
	}
	const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
	const res = await env.HATH_DB.prepare("SELECT fileid, request_count, bytes_sent, last_seen_ts FROM file_stats WHERE client_ip = ? ORDER BY request_count DESC LIMIT ?").bind(clientIp, limit).all();
	const files = (res.results || []).map((row) => {
		addFileMetadata(row);
		row.last_seen = formatTimestamp(row.last_seen_ts, tzOffsetSeconds);
		return row;
	});
	return jsonResponse({ files: files });
}

async function handleTopIps(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}

	if(hasStatsApi(env)) {
		return proxyStatsApiJson(env, copyQuery(request, "/v1/top/ips", ["client_ip", "name", "limit", "tz"]));
	}

	const url = new URL(request.url);
	const tzOffsetSeconds = getTzOffsetSeconds(url);
	let clientIp = url.searchParams.get("client_ip");
	const name = url.searchParams.get("name");
	if(!clientIp && name) {
		const ipRes = await env.HATH_DB.prepare("SELECT client_ip FROM clients WHERE name = ? ORDER BY last_seen_ts DESC LIMIT 1").bind(name).all();
		clientIp = ipRes.results && ipRes.results[0] ? ipRes.results[0].client_ip : null;
	}
	if(!clientIp) {
		return jsonResponse({ error: "missing_client" }, 400);
	}
	const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
	const res = await env.HATH_DB.prepare("SELECT requester_ip, request_count, bytes_sent, last_seen_ts FROM ip_stats WHERE client_ip = ? ORDER BY request_count DESC LIMIT ?").bind(clientIp, limit).all();
	const ips = (res.results || []).map((row) => {
		row.last_seen = formatTimestamp(row.last_seen_ts, tzOffsetSeconds);
		return row;
	});
	return jsonResponse({ ips: ips });
}

async function resolveClient(request, env) {
	const url = new URL(request.url);
	const clientIp = url.searchParams.get("client_ip");
	const name = url.searchParams.get("name");

	if(hasStatsApi(env)) {
		const path = copyQuery(request, "/v1/client/resolve", ["client_ip", "name"]);
		try {
			return await callStatsApi(env, path);
		}
		catch(e) {
			if(e.status === 404) {
				return null;
			}
			throw e;
		}
	}

	await deleteExpiredClients(env, Math.floor(Date.now() / 1000));

	if(clientIp) {
		const res = await env.HATH_DB.prepare("SELECT client_ip, name, cache_url FROM clients WHERE client_ip = ? LIMIT 1").bind(clientIp).all();
		return res.results && res.results[0] ? res.results[0] : null;
	}

	if(name) {
		const res = await env.HATH_DB.prepare("SELECT client_ip, name, cache_url FROM clients WHERE name = ? ORDER BY last_seen_ts DESC LIMIT 1").bind(name).all();
		return res.results && res.results[0] ? res.results[0] : null;
	}

	const res = await env.HATH_DB.prepare("SELECT client_ip, name, cache_url FROM clients WHERE cache_url IS NOT NULL AND cache_url != '' ORDER BY last_seen_ts DESC LIMIT 1").all();
	return res.results && res.results[0] ? res.results[0] : null;
}

async function handleCacheTree(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}

	const url = new URL(request.url);
	let client;
	try {
		client = await resolveClient(request, env);
	}
	catch(e) {
		return jsonResponse(e.data || { error: e.message || "stats_api_error" }, e.status || 502);
	}
	if(!client) {
		return jsonResponse({ error: "missing_client" }, 400);
	}

	const cacheRef = parseCacheUrl(client.cache_url);
	if(!cacheRef) {
		return jsonResponse({ error: "missing_cache_url" }, 400);
	}

	const prefix = String(url.searchParams.get("prefix") || "").toLowerCase();
	if(!/^[a-f0-9]{0,40}$/.test(prefix)) {
		return jsonResponse({ error: "invalid_prefix" }, 400);
	}

	const limit = Math.min(Number(url.searchParams.get("limit") || 500), 1000);
	const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
	const clientUrl = buildClientPath(cacheRef, "list", "prefix=" + prefix + ";limit=" + limit + ";offset=" + offset);
	let upstream;
	try {
		upstream = await fetch(clientUrl, { headers: { "Accept": "application/json" } });
	}
	catch(e) {
		return jsonResponse({ error: "client_fetch_failed", detail: e.message || String(e), direct_url: clientUrl }, 502);
	}
	if(!upstream.ok) {
		return jsonResponse({ error: "client_fetch_failed", status: upstream.status, detail: await upstream.text(), direct_url: clientUrl }, 502);
	}

	const data = await upstream.json();
	for(const item of (data.items || [])) {
		if(item.type === "file") {
			addFileMetadata(item);
			item.direct_url = buildClientPath(cacheRef, "file", item.fileid);
		}
	}
	data.client = { name: client.name, client_ip: client.client_ip };
	return jsonResponse(data);
}

async function handleCacheFile(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}

	const url = new URL(request.url);
	const fileId = String(url.searchParams.get("fileid") || "");
	if(!/^([a-f0-9]{40})-\d+(?:-\d+-\d+)?-(jpg|png|gif|mp4|wbm|wbp|avf|jxl)$/.test(fileId)) {
		return jsonResponse({ error: "invalid_fileid" }, 400);
	}

	let client;
	try {
		client = await resolveClient(request, env);
	}
	catch(e) {
		return jsonResponse(e.data || { error: e.message || "stats_api_error" }, e.status || 502);
	}
	if(!client) {
		return jsonResponse({ error: "missing_client" }, 400);
	}

	const cacheRef = parseCacheUrl(client.cache_url);
	if(!cacheRef) {
		return jsonResponse({ error: "missing_cache_url" }, 400);
	}

	const clientUrl = buildClientPath(cacheRef, "file", fileId);
	let upstream;
	try {
		upstream = await fetch(clientUrl);
	}
	catch(e) {
		return jsonResponse({ error: "client_fetch_failed", detail: e.message || String(e), direct_url: clientUrl }, 502);
	}
	if(!upstream.ok) {
		return jsonResponse({ error: "client_fetch_failed", status: upstream.status, detail: await upstream.text(), direct_url: clientUrl }, 502);
	}

	const headers = new Headers();
	headers.set("Content-Type", upstream.headers.get("Content-Type") || getMimeType(fileId.split("-").pop()));
	headers.set("Cache-Control", "private, max-age=60");
	headers.set("Content-Disposition", "inline");
	const length = upstream.headers.get("Content-Length");
	if(length) {
		headers.set("Content-Length", length);
	}
	return new Response(upstream.body, { status: 200, headers: headers });
}

async function handleCacheProbe(request, env) {
	if(!hasStatsStore(env)) {
		return statsStoreMissingResponse();
	}

	let client;
	try {
		client = await resolveClient(request, env);
	}
	catch(e) {
		return jsonResponse(e.data || { error: e.message || "stats_api_error" }, e.status || 502);
	}
	if(!client) {
		return jsonResponse({ error: "missing_client" }, 400);
	}

	const cacheRef = parseCacheUrl(client.cache_url);
	if(!cacheRef) {
		return jsonResponse({ error: "missing_cache_url", cache_url: client.cache_url || "" }, 400);
	}

	const clientUrl = buildClientPath(cacheRef, "list", "prefix=;limit=1;offset=0");
	let upstream;
	try {
		upstream = await fetch(clientUrl, { headers: { "Accept": "application/json" } });
	}
	catch(e) {
		return jsonResponse({
			ok: false,
			error: "client_fetch_failed",
			detail: e.message || String(e),
			client: { name: client.name, client_ip: client.client_ip },
			cache_url: client.cache_url || "",
			fetch_url: clientUrl
		}, 502);
	}

	const body = await upstream.text();
	return jsonResponse({
		ok: upstream.ok,
		status: upstream.status,
		content_type: upstream.headers.get("Content-Type") || "",
		body_sample: body.substring(0, 500),
		client: { name: client.name, client_ip: client.client_ip },
		cache_url: client.cache_url || "",
		fetch_url: clientUrl
	}, upstream.ok ? 200 : 502);
}

export class HathStatsDurableObject {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.stats = new Map();
		this.clients = new Map();
		this.pendingEvents = 0;
		this.lastCheckpointMs = 0;
		this.loaded = this.load();
	}

	async load() {
		const stored = await this.state.storage.get(["stats", "clients", "pending_events", "last_checkpoint_ms"]);
		this.stats = new Map(Object.entries(stored.get("stats") || {}));
		this.clients = new Map(Object.entries(stored.get("clients") || {}));
		this.pendingEvents = Number(stored.get("pending_events") || 0);
		this.lastCheckpointMs = Number(stored.get("last_checkpoint_ms") || 0);

		const alarm = await this.state.storage.getAlarm();
		if(alarm === null) {
			await this.state.storage.setAlarm(Date.now() + STATS_FLUSH_INTERVAL_S * 1000);
		}
	}

	async checkpoint(force) {
		const nowMs = Date.now();
		if(!force && this.pendingEvents < DO_CHECKPOINT_EVENT_LIMIT && nowMs - this.lastCheckpointMs < DO_CHECKPOINT_INTERVAL_S * 1000) {
			return;
		}

		await this.state.storage.put({
			stats: Object.fromEntries(this.stats),
			clients: Object.fromEntries(this.clients),
			pending_events: 0,
			last_checkpoint_ms: nowMs
		});
		this.pendingEvents = 0;
		this.lastCheckpointMs = nowMs;
	}

	async flushClient(clientIp) {
		let clientWrites = 0;
		let statWrites = 0;

		const cached = this.clients.get(clientIp);
		if(cached && cached.row) {
			await writeClientRecord(this.env, cached.row);
			this.clients.delete(clientIp);
			clientWrites = 1;
		}

		const aggregate = this.stats.get(clientIp);
		if(aggregate) {
			statWrites = await flushStatsAggregate(this.env, clientIp, aggregate);
			this.stats.delete(clientIp);
		}

		if(clientWrites > 0 || statWrites > 0) {
			await this.checkpoint(true);
		}

		return { clientWrites: clientWrites, statWrites: statWrites };
	}

	async flushExpired(now) {
		const currentBucket = getHourBucket(now);
		let clientWrites = 0;
		let statWrites = 0;

		for(const [clientIp, cached] of Array.from(this.clients.entries())) {
			if(cached && Number(cached.bucket_start_ts || 0) < currentBucket && cached.row) {
				await writeClientRecord(this.env, cached.row);
				this.clients.delete(clientIp);
				clientWrites += 1;
			}
		}

		for(const [clientIp, aggregate] of Array.from(this.stats.entries())) {
			if(aggregate && Number(aggregate.bucket_start_ts || 0) < currentBucket) {
				statWrites += await flushStatsAggregate(this.env, clientIp, aggregate);
				this.stats.delete(clientIp);
			}
		}

		if(clientWrites > 0 || statWrites > 0) {
			await this.checkpoint(true);
		}

		return { clientWrites: clientWrites, statWrites: statWrites };
	}

	async flushAll() {
		let clientWrites = 0;
		let statWrites = 0;

		for(const clientIp of Array.from(new Set([...this.clients.keys(), ...this.stats.keys()]))) {
			const flushed = await this.flushClient(clientIp);
			clientWrites += flushed.clientWrites;
			statWrites += flushed.statWrites;
		}

		await this.checkpoint(true);
		return { clientWrites: clientWrites, statWrites: statWrites };
	}

	async handleIngest(request) {
		let body;
		try {
			body = await request.json();
		}
		catch(e) {
			return jsonResponse({ error: "invalid_json" }, 400);
		}

		const clientId = Number(body.client_id || 0);
		if(!clientId) {
			return jsonResponse({ error: "missing_client_id" }, 400);
		}

		const clientIp = request.headers.get("X-Hath-Client-IP") || "unknown";
		const now = Number(body.ts || Math.floor(Date.now() / 1000));
		const events = Array.isArray(body.events) ? body.events : [];
		let flushed = 0;

		if(body.uptime_s !== undefined) {
			flushed += await queueClientRecord(this.env, this.clients, buildClientRecord(body, clientIp, now));
		}

		if(events.length > 0) {
			flushed += await queueStatsAggregate(this.env, this.stats, clientIp, events, now);
			this.pendingEvents += events.length;
		}

		await this.checkpoint(flushed > 0);
		return jsonResponse({ ok: true, mode: "durable_object", events: events.length, flushed: flushed });
	}

	async handleFlush(request) {
		const url = new URL(request.url);
		const all = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
		const clientIp = url.searchParams.get("client_ip") || request.headers.get("X-Hath-Client-IP") || "unknown";
		const flushed = all ? await this.flushAll() : await this.flushClient(clientIp);
		return jsonResponse({
			ok: true,
			mode: "durable_object",
			client_ip: all ? null : clientIp,
			flushed: flushed.clientWrites + flushed.statWrites,
			client_writes: flushed.clientWrites,
			stat_writes: flushed.statWrites
		});
	}

	async alarm() {
		await this.loaded;
		await this.flushExpired(Math.floor(Date.now() / 1000));
		await this.checkpoint(true);
		await this.state.storage.setAlarm(Date.now() + STATS_FLUSH_INTERVAL_S * 1000);
	}

	async fetch(request) {
		await this.loaded;
		const url = new URL(request.url);

		if(request.method === "POST" && url.pathname === "/ingest") {
			return this.handleIngest(request);
		}

		if(request.method === "POST" && url.pathname === "/flush") {
			return this.handleFlush(request);
		}

		return jsonResponse({ error: "not_found" }, 404);
	}
}

function getDashboardHtml(request) {
	const url = new URL(request.url);
	const token = url.searchParams.get("token") || "";
	return dashboardHtmlRaw.replace("\"{{AUTH_TOKEN}}\"", () => jsString(token));
}

function getCacheBrowserHtml(request) {
	const url = new URL(request.url);
	const tokenParam = getReadTokenParam(request);
	const initialName = url.searchParams.get("name") || "";
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>H@H Cache Browser</title>
<style>
:root{color-scheme:dark;--bg:#232323;--fg:#eee;--muted:#93a19b;--title:#9bd48f;--bar:#443f3f;--link:#f0e6c8;--tag:#6aa5a4;--size:#92be82;--line:#343434}
body.light{color-scheme:light;--bg:#f6f4ef;--fg:#252525;--muted:#66736e;--title:#367c45;--bar:#ddd8d0;--link:#29323a;--tag:#6ba6a6;--size:#79a96d;--line:#ded8cd}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:Arial,Helvetica,sans-serif;font-size:15px}.wrap{max-width:1480px;margin:34px auto 28px;padding:0 24px}h1{margin:0 0 18px;color:var(--title);font-size:40px;font-weight:300}.layout{display:grid;grid-template-columns:minmax(440px,1fr) minmax(360px,42%);gap:20px;align-items:start}.bar{display:flex;gap:18px;align-items:center;flex-wrap:wrap;background:var(--bar);border-radius:8px;padding:13px 18px;margin-bottom:18px}select,input[type=text]{background:transparent;color:var(--fg);border:1px solid var(--muted);border-radius:4px;padding:4px 8px}button{background:transparent;color:var(--link);border:1px solid var(--muted);border-radius:4px;padding:4px 9px;cursor:pointer}.path{color:var(--muted);margin-left:auto}.path code{color:var(--link)}.list{min-width:0}.entry{display:grid;grid-template-columns:34px minmax(0,1fr) auto auto auto;gap:10px;align-items:center;min-height:42px}.entry:hover{background:rgba(255,255,255,.04)}body.light .entry:hover{background:rgba(0,0,0,.04)}a{color:var(--link);text-decoration:none}.name{overflow-wrap:anywhere}.sub{display:block;margin-top:2px;color:var(--muted);font-size:12px}.pill{display:inline-block;border-radius:4px;padding:3px 7px;color:#fff;background:var(--tag);font-size:12px}.bytes{background:var(--size)}.icon{position:relative;width:25px;height:23px;display:inline-block}.folder:before{content:'';position:absolute;left:1px;top:7px;width:23px;height:14px;border:2px solid #77a7bc;border-radius:2px}.folder:after{content:'';position:absolute;left:3px;top:3px;width:10px;height:6px;border:2px solid #77a7bc;border-bottom:0}.file:before{content:'';position:absolute;left:5px;top:1px;width:15px;height:21px;border:2px solid #8db3c2}.file:after{content:'';position:absolute;left:9px;top:7px;width:8px;height:2px;background:#8db3c2;box-shadow:0 5px 0 #8db3c2,0 10px 0 #8db3c2}.up{font-size:28px;color:#75a2b6}.preview{position:sticky;top:20px;min-height:360px;background:rgba(0,0,0,.12);border:1px solid var(--line);border-radius:6px;padding:14px;overflow:hidden}.preview img,.preview video{display:block;width:100%;max-height:calc(100vh - 160px);object-fit:contain;background:#000;border-radius:4px}.caption{color:var(--muted);margin-bottom:10px;overflow-wrap:anywhere}.empty{height:320px;display:grid;place-items:center;color:var(--muted);border:1px dashed var(--line);border-radius:4px}.nav-buttons{display:flex;gap:10px;margin-top:14px;align-items:center}.nav-buttons button{flex:1}.footer{margin-top:34px;text-align:center;color:var(--muted);font-size:12px}@media(max-width:900px){.wrap{margin-top:24px;padding:0 16px}h1{font-size:36px}.layout{display:block}.preview{position:static;margin-top:18px}.entry{grid-template-columns:30px minmax(0,1fr)}.entry .pill,.entry .age{display:none}.path{width:100%;margin-left:0}}
</style></head><body><main class="wrap"><h1>File Browser</h1>
<section class="bar">
<label>client: <select id="client"></select></label>
<label>sort list by: <input type="radio" name="sort" value="date" checked onchange="renderList()"> date <input type="radio" name="sort" value="name" onchange="renderList()"> name <input type="radio" name="sort" value="size" onchange="renderList()"> size</label>
<label>theme: <input type="radio" name="theme" value="light" onchange="setTheme(this.value)"> light <input type="radio" name="theme" value="dark" checked onchange="setTheme(this.value)"> dark</label>
<label>prefix: <input id="prefix" type="text" placeholder="e03c"></label><button onclick="goPrefix()">open</button><button onclick="refreshData()">refresh</button><span class="path">/cache/<code id="path"></code></span>
</section><div class="layout"><section id="list" class="list"></section><aside id="preview" class="preview"><div class="empty">Select a file to preview.</div></aside></div><div class="footer">H@H cache browser via Worker</div></main>
<script>
const auth='${tokenParam}';const initialName=${jsString(initialName)};let currentPrefix='',currentItems=[],currentDirectUrls={},nextOffset=null,offset=0;const limit=500;let sortedFiles=[],currentIndex=-1;
function qs(){const c=document.getElementById('client').value;return 'name='+encodeURIComponent(c)+auth;}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function size(n){n=Number(n||0);const u=['bytes','KB','MB','GB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return (i===0?Math.round(n):n.toFixed(2))+' '+u[i];}
function age(ts){if(!ts)return '';let s=Math.max(1,Math.floor(Date.now()/1000-ts));for(const [n,v] of [['year',31536000],['month',2592000],['day',86400],['hour',3600],['minute',60]]){if(s>=v){const x=Math.floor(s/v);return x+' '+n+(x>1?'s':'')+' ago';}}return 'seconds ago';}
function sortMode(){return document.querySelector('input[name=sort]:checked')?.value||'date';}
function setTheme(v){document.body.className=v==='light'?'light':'';}
function parentPrefix(){if(currentPrefix.length>=4)return currentPrefix.substring(0,2);if(currentPrefix.length>=2)return '';return null;}
function goPrefix(){openPrefix(document.getElementById('prefix').value.trim().toLowerCase());}
async function loadClients(){const res=await fetch('/v1/clients?'+auth.substring(1));const data=await res.json();const sel=document.getElementById('client');sel.innerHTML='';for(const c of data.clients||[]){const o=document.createElement('option');o.value=c.name||c.client_ip;o.textContent=(c.name||c.client_ip)+(c.cache_url?'':' (no cache url)');sel.appendChild(o);}if(initialName){sel.value=initialName;}sel.onchange=()=>openPrefix('');if(sel.value){await openPrefix('');}else{document.getElementById('list').innerHTML='<div class=entry><span></span><span class=name>No clients found.</span><span></span><span></span><span></span></div>';}}
async function refreshData(){const r=await fetch('/v1/refresh?'+auth.substring(1),{method:'POST'});const data=await r.json();if(!r.ok||data.error){document.getElementById('list').innerHTML='<div class=entry><span></span><span class=name>refresh failed<span class=sub>'+esc(data.error||data.detail||r.status)+'</span></span><span></span><span></span><span></span></div>';return;}await loadClients();}
async function openPrefix(prefix,append){if(!append){offset=0;currentItems=[];currentDirectUrls={};}currentPrefix=prefix||'';document.getElementById('prefix').value=currentPrefix;document.getElementById('path').textContent=currentPrefix?currentPrefix.match(/.{1,2}/g).join('/')+'/':'';const res=await fetch('/v1/cache/tree?'+qs()+'&prefix='+currentPrefix+'&limit='+limit+'&offset='+offset);const data=await res.json();if(data.error){const direct=data.direct_url?' <a href="'+esc(data.direct_url)+'" target="_blank" rel="noopener">open direct</a>':'';const more=[data.status?'status='+data.status:'',data.detail?'detail='+data.detail:''].filter(Boolean).join(' | ');document.getElementById('list').innerHTML='<div class=entry><span></span><span class=name>'+esc(data.error)+direct+(more?'<span class=sub>'+esc(more)+'</span>':'')+'</span><span></span><span></span><span></span></div>';return;}for(const item of data.items||[]){if(item.type==='file'&&item.direct_url){currentDirectUrls[item.fileid]=item.direct_url;}}currentItems=currentItems.concat(data.items||[]);nextOffset=data.next_offset;renderList();}
function renderList(){const list=document.getElementById('list');let items=currentItems.slice();const mode=sortMode();items.sort((a,b)=>a.type!==b.type?a.type==='dir'?-1:1:mode==='size'?(b.size||0)-(a.size||0):mode==='date'?(b.last_modified||0)-(a.last_modified||0):String(a.name||a.display_name||a.fileid).localeCompare(String(b.name||b.display_name||b.fileid)));const oldFileId=currentIndex>=0?sortedFiles[currentIndex]?.fileid:null;sortedFiles=items.filter(i=>i.type==='file');if(oldFileId)currentIndex=sortedFiles.findIndex(f=>f.fileid===oldFileId);let html='';const parent=parentPrefix();if(parent!==null){html+='<div class=entry><span class=up>&#8634;</span><a class=name href=# onclick="openPrefix(\\''+parent+'\\');return false;">..</a><span></span><span></span><span></span></div>';}let folderCount=0;let fileCount=0;for(const item of items){if(item.type==='dir'){folderCount++;html+='<div class=entry><span class="icon folder"></span><a class=name href=# onclick="openPrefix(\\''+esc(item.prefix)+'\\');return false;">'+esc(item.name)+'</a><span class=pill>folder</span><span></span><span></span></div>';}else{fileCount++;html+='<div class=entry><span class="icon file"></span><a class=name href=# onclick="preview(\\''+esc(item.fileid)+'\\',\\''+esc(item.mime)+'\\');return false;">'+esc(item.display_name||item.fileid)+'<span class=sub>'+esc(item.fileid)+'</span></a><span class=pill>'+esc(item.extension||item.mime)+'</span><span class="pill bytes">'+size(item.size)+'</span><span class="sub age">'+age(item.last_modified)+'</span></div>';}}if(folderCount||fileCount){html+='<div style="margin-top:16px;color:var(--muted);font-size:12px;padding:0 8px;">'+(folderCount?folderCount+' folder(s)':'')+(folderCount&&fileCount?', ':'')+(fileCount?fileCount+' file(s)':'')+'</div>';}if(nextOffset!=null){html+='<div style="margin-top:16px"><button onclick="offset=nextOffset;openPrefix(currentPrefix,true)">load more</button></div>';}list.innerHTML=html;}
function preview(fileid,mime,index){if(index===undefined)index=sortedFiles.findIndex(f=>f.fileid===fileid);currentIndex=index;const url='/v1/cache/file?'+qs()+'&fileid='+encodeURIComponent(fileid);const direct=currentDirectUrls[fileid]||'';const directLink=direct?' <a href="'+esc(direct)+'" target="_blank" rel="noopener">open direct</a>':'';const box=document.getElementById('preview');const cap='<div class=caption>'+esc(fileid)+directLink+'</div>';const nav='<div class="nav-buttons"><button onclick="navigate(-1)" '+(currentIndex<=0?'disabled':'')+'>Previous</button><button onclick="navigate(1)" '+(currentIndex>=sortedFiles.length-1?'disabled':'')+'>Next</button></div>';box.innerHTML=mime.startsWith('video/')?cap+'<video controls src="'+url+'"></video>'+nav:cap+'<img src="'+url+'" />'+nav;const media=box.querySelector('img,video');if(media){media.onerror=()=>{box.innerHTML=direct?'<div class=caption>Proxy failed. '+directLink+'</div>':'<div class=caption>Proxy failed.</div>';};}}
function navigate(dir){const newIndex=currentIndex+dir;if(newIndex>=0&&newIndex<sortedFiles.length){const item=sortedFiles[newIndex];preview(item.fileid,item.mime,newIndex);}}
window.addEventListener('keydown',e=>{if(document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='SELECT')return;if(e.key==='ArrowLeft')navigate(-1);if(e.key==='ArrowRight')navigate(1);});
loadClients();
</script></body></html>`;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if(request.method === "GET" && (url.pathname === "/cache" || url.pathname === "/v1/cache" || url.pathname === "/v1/cache/browser")) {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return htmlResponse(getCacheBrowserHtml(request));
		}

		if(request.method === "GET" && url.pathname === "/dashboard") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return htmlResponse(getDashboardHtml(request));
		}

		if(request.method === "GET" && url.pathname === "/v1/cache/tree") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleCacheTree(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/cache/file") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleCacheFile(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/cache/probe") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleCacheProbe(request, env);
		}

		if(request.method === "POST" && url.pathname === "/v1/ingest") {
			const authError = requireAuth(request, env, "HATH_INGEST_TOKEN", false);
			if(authError) {
				return authError;
			}
			return handleIngest(request, env);
		}

		if(request.method === "POST" && url.pathname === "/v1/flush") {
			const authError = requireAuth(request, env, "HATH_INGEST_TOKEN", false);
			if(authError) {
				return authError;
			}
			return handleFlush(request, env);
		}

		if((request.method === "GET" || request.method === "POST") && url.pathname === "/v1/refresh") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleRefresh(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/overview") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleOverview(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/clients") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleClients(request, env);
		}

		if(request.method === "GET" && (url.pathname === "/v1/top/files" || url.pathname === "/v1/cache/files")) {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleTopFiles(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/top/ips") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleTopIps(request, env);
		}

		return jsonResponse({ error: "not_found" }, 404);
	}
};
