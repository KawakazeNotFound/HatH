const JSON_HEADERS = {"Content-Type": "application/json"};

function jsonResponse(data, status) {
	return new Response(JSON.stringify(data), { status: status || 200, headers: JSON_HEADERS });
}

function requireAuth(request, env) {
	if(!env.HATH_TOKEN) {
		return null;
	}

	const token = request.headers.get("X-Auth-Token");
	if(token !== env.HATH_TOKEN) {
		return jsonResponse({ error: "unauthorized" }, 401);
	}

	return null;
}

async function handleIngest(request, env) {
	const authError = requireAuth(request, env);
	if(authError) {
		return authError;
	}

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

	const now = Number(body.ts || Math.floor(Date.now() / 1000));
	const events = Array.isArray(body.events) ? body.events : [];

	if(body.uptime_s !== undefined) {
		await env.HATH_DB.prepare(
			"INSERT INTO clients (client_id, last_seen_ts, uptime_s, files_sent, bytes_sent, cache_count, cache_size, open_connections) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
			"ON CONFLICT(client_id) DO UPDATE SET last_seen_ts=excluded.last_seen_ts, uptime_s=excluded.uptime_s, files_sent=excluded.files_sent, bytes_sent=excluded.bytes_sent, cache_count=excluded.cache_count, cache_size=excluded.cache_size, open_connections=excluded.open_connections"
		).bind(
			clientId,
			now,
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
					"INSERT INTO file_stats (fileid, request_count, bytes_sent, last_seen_ts) VALUES (?, 1, ?, ?) " +
					"ON CONFLICT(fileid) DO UPDATE SET request_count=request_count+1, bytes_sent=bytes_sent+excluded.bytes_sent, last_seen_ts=excluded.last_seen_ts"
				).bind(fileId, bytes, evTs));
			}

			if(ip.length > 0) {
				stmts.push(env.HATH_DB.prepare(
					"INSERT INTO ip_stats (ip, request_count, bytes_sent, last_seen_ts) VALUES (?, 1, ?, ?) " +
					"ON CONFLICT(ip) DO UPDATE SET request_count=request_count+1, bytes_sent=bytes_sent+excluded.bytes_sent, last_seen_ts=excluded.last_seen_ts"
				).bind(ip, bytes, evTs));
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

	const clientCount = await env.HATH_DB.prepare("SELECT COUNT(*) AS count FROM clients").all();
	const totalRequests = await env.HATH_DB.prepare("SELECT SUM(request_count) AS total FROM file_stats").all();
	const topFile = await env.HATH_DB.prepare("SELECT fileid, request_count, bytes_sent FROM file_stats ORDER BY request_count DESC LIMIT 1").all();
	const topIp = await env.HATH_DB.prepare("SELECT ip, request_count, bytes_sent FROM ip_stats ORDER BY request_count DESC LIMIT 1").all();

	return jsonResponse({
		client_count: (clientCount.results[0] && clientCount.results[0].count) || 0,
		total_requests: (totalRequests.results[0] && totalRequests.results[0].total) || 0,
		top_file: topFile.results[0] || null,
		top_ip: topIp.results[0] || null
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
	const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
	const res = await env.HATH_DB.prepare("SELECT fileid, request_count, bytes_sent, last_seen_ts FROM file_stats ORDER BY request_count DESC LIMIT ?").bind(limit).all();
	return jsonResponse({ files: res.results || [] });
}

async function handleTopIps(request, env) {
	if(!env.HATH_DB) {
		return jsonResponse({ error: "missing_db" }, 500);
	}

	const url = new URL(request.url);
	const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
	const res = await env.HATH_DB.prepare("SELECT ip, request_count, bytes_sent, last_seen_ts FROM ip_stats ORDER BY request_count DESC LIMIT ?").bind(limit).all();
	return jsonResponse({ ips: res.results || [] });
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if(request.method === "POST" && url.pathname === "/v1/ingest") {
			return handleIngest(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/overview") {
			return handleOverview(env);
		}

		if(request.method === "GET" && url.pathname === "/v1/clients") {
			return handleClients(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/top/files") {
			return handleTopFiles(request, env);
		}

		if(request.method === "GET" && url.pathname === "/v1/top/ips") {
			return handleTopIps(request, env);
		}

		return jsonResponse({ error: "not_found" }, 404);
	}
};
