const JSON_HEADERS = {"Content-Type": "application/json"};

function jsonResponse(data, status) {
	return new Response(JSON.stringify(data), { status: status || 200, headers: JSON_HEADERS });
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

async function handleIngest(request, env) {
	if(!env.HATH_DB) {
		return jsonResponse({ error: "missing_db" }, 500);
	}

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

	const clientIp = getClientIp(request);

	const now = Number(body.ts || Math.floor(Date.now() / 1000));
	const events = Array.isArray(body.events) ? body.events : [];

	if(body.uptime_s !== undefined) {
		const name = String(body.name || "");
		let timeout = Number(body.timeout || 0);
		if(!timeout || timeout < 60) {
			timeout = 600;
		}
		timeout = Math.min(timeout, 43200);

		await env.HATH_DB.prepare(
			"INSERT INTO clients (client_ip, name, last_seen_ts, timeout_s, uptime_s, files_sent, bytes_sent, cache_count, cache_size, open_connections) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
			"ON CONFLICT(client_ip) DO UPDATE SET name=excluded.name, last_seen_ts=excluded.last_seen_ts, timeout_s=excluded.timeout_s, uptime_s=excluded.uptime_s, files_sent=excluded.files_sent, bytes_sent=excluded.bytes_sent, cache_count=excluded.cache_count, cache_size=excluded.cache_size, open_connections=excluded.open_connections"
		).bind(
			clientIp,
			name,
			now,
			timeout,
			Number(body.uptime_s || 0),
			Number(body.files_sent || 0),
			Number(body.bytes_sent || 0),
			Number(body.cache_count || 0),
			Number(body.cache_size || 0),
			Number(body.open_connections || 0)
		).run();
	}

	if(events.length > 0) {
		const stmts = [];
		for(const ev of events) {
			const fileId = String(ev.fileid || "");
			const ip = String(ev.ip || "");
			const bytes = Number(ev.bytes || 0);
			const evTs = Number(ev.ts || now);

			if(fileId.length > 0) {
				stmts.push(env.HATH_DB.prepare(
					"INSERT INTO file_stats (client_ip, fileid, request_count, bytes_sent, last_seen_ts) VALUES (?, ?, 1, ?, ?) " +
					"ON CONFLICT(client_ip, fileid) DO UPDATE SET request_count=request_count+1, bytes_sent=bytes_sent+excluded.bytes_sent, last_seen_ts=excluded.last_seen_ts"
				).bind(clientIp, fileId, bytes, evTs));
			}

			if(ip.length > 0) {
				stmts.push(env.HATH_DB.prepare(
					"INSERT INTO ip_stats (client_ip, requester_ip, request_count, bytes_sent, last_seen_ts) VALUES (?, ?, 1, ?, ?) " +
					"ON CONFLICT(client_ip, requester_ip) DO UPDATE SET request_count=request_count+1, bytes_sent=bytes_sent+excluded.bytes_sent, last_seen_ts=excluded.last_seen_ts"
				).bind(clientIp, ip, bytes, evTs));
			}
		}

		if(stmts.length > 0) {
			await env.HATH_DB.batch(stmts);
		}
	}

	return jsonResponse({ ok: true, events: events.length });
}

async function handleOverview(env) {
	if(!env.HATH_DB) {
		return jsonResponse({ error: "missing_db" }, 500);
	}

	const now = Math.floor(Date.now() / 1000);
	const res = await env.HATH_DB.prepare(
		"SELECT client_ip, name, last_seen_ts, timeout_s, uptime_s, files_sent, bytes_sent, cache_count, cache_size, open_connections, " +
		"(SELECT SUM(request_count) FROM file_stats f WHERE f.client_ip = c.client_ip) AS total_requests " +
		"FROM clients c ORDER BY last_seen_ts DESC"
	).all();

	const clientsByName = {};
	let totalRequests = 0;
	for(const row of (res.results || [])) {
		const timeout = Math.min(Number(row.timeout_s || 600), 43200);
		const active = Number(row.last_seen_ts || 0) >= (now - timeout);
		const clientIp = row.client_ip;
		let topFile = null;
		let topIp = null;

		if(clientIp) {
			const topFileRes = await env.HATH_DB.prepare(
				"SELECT fileid, request_count, bytes_sent, last_seen_ts FROM file_stats WHERE client_ip = ? ORDER BY request_count DESC, bytes_sent DESC LIMIT 1"
			).bind(clientIp).all();
			if(topFileRes.results && topFileRes.results.length > 0) {
				topFile = topFileRes.results[0];
			}

			const topIpRes = await env.HATH_DB.prepare(
				"SELECT requester_ip AS ip, request_count, bytes_sent, last_seen_ts FROM ip_stats WHERE client_ip = ? ORDER BY request_count DESC, bytes_sent DESC LIMIT 1"
			).bind(clientIp).all();
			if(topIpRes.results && topIpRes.results.length > 0) {
				topIp = topIpRes.results[0];
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
			last_seen_ts: row.last_seen_ts,
			timeout_s: timeout,
			active: active,
			uptime_s: row.uptime_s || 0,
			files_sent: row.files_sent || 0,
			bytes_sent: row.bytes_sent || 0,
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
	if(!env.HATH_DB) {
		return jsonResponse({ error: "missing_db" }, 500);
	}

	const url = new URL(request.url);
	const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
	const res = await env.HATH_DB.prepare("SELECT * FROM clients ORDER BY last_seen_ts DESC LIMIT ?").bind(limit).all();
	return jsonResponse({ clients: res.results || [] });
}

async function handleTopFiles(request, env) {
	if(!env.HATH_DB) {
		return jsonResponse({ error: "missing_db" }, 500);
	}

	const url = new URL(request.url);
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
	return jsonResponse({ files: res.results || [] });
}

async function handleTopIps(request, env) {
	if(!env.HATH_DB) {
		return jsonResponse({ error: "missing_db" }, 500);
	}

	const url = new URL(request.url);
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
	return jsonResponse({ ips: res.results || [] });
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if(request.method === "POST" && url.pathname === "/v1/ingest") {
			const authError = requireAuth(request, env, "HATH_INGEST_TOKEN", false);
			if(authError) {
				return authError;
			}
			return handleIngest(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/overview") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleOverview(env);
		}

		if(request.method === "GET" && url.pathname === "/v1/clients") {
			const authError = requireAuth(request, env, "HATH_READ_TOKEN", true);
			if(authError) {
				return authError;
			}
			return handleClients(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/top/files") {
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
