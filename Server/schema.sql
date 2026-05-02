CREATE TABLE IF NOT EXISTS clients (
	client_ip TEXT PRIMARY KEY,
	name TEXT,
	cache_url TEXT,
	last_seen_ts BIGINT,
	timeout_s BIGINT,
	uptime_s BIGINT,
	files_sent BIGINT,
	bytes_sent BIGINT,
	cache_count BIGINT,
	cache_size BIGINT,
	open_connections BIGINT
);

CREATE TABLE IF NOT EXISTS file_stats (
	client_ip TEXT NOT NULL,
	fileid TEXT NOT NULL,
	request_count BIGINT NOT NULL DEFAULT 0,
	bytes_sent BIGINT NOT NULL DEFAULT 0,
	last_seen_ts BIGINT NOT NULL DEFAULT 0,
	PRIMARY KEY (client_ip, fileid)
);

CREATE TABLE IF NOT EXISTS ip_stats (
	client_ip TEXT NOT NULL,
	requester_ip TEXT NOT NULL,
	request_count BIGINT NOT NULL DEFAULT 0,
	bytes_sent BIGINT NOT NULL DEFAULT 0,
	last_seen_ts BIGINT NOT NULL DEFAULT 0,
	PRIMARY KEY (client_ip, requester_ip)
);

CREATE TABLE IF NOT EXISTS client_totals (
	client_ip TEXT PRIMARY KEY,
	total_requests BIGINT NOT NULL DEFAULT 0,
	bytes_sent BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS clients_last_seen_idx
	ON clients (last_seen_ts DESC);

CREATE INDEX IF NOT EXISTS clients_name_last_seen_idx
	ON clients (name, last_seen_ts DESC);

CREATE INDEX IF NOT EXISTS clients_cache_url_last_seen_idx
	ON clients (last_seen_ts DESC)
	WHERE cache_url IS NOT NULL AND cache_url <> '';

CREATE INDEX IF NOT EXISTS file_stats_client_top_idx
	ON file_stats (client_ip, request_count DESC, bytes_sent DESC);

CREATE INDEX IF NOT EXISTS ip_stats_client_top_idx
	ON ip_stats (client_ip, request_count DESC, bytes_sent DESC);
