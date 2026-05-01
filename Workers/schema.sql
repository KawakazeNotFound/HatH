CREATE TABLE IF NOT EXISTS clients (
	client_id INTEGER PRIMARY KEY,
	last_seen_ts INTEGER,
	uptime_s INTEGER,
	files_sent INTEGER,
	bytes_sent INTEGER,
	cache_count INTEGER,
	cache_size INTEGER,
	open_connections INTEGER
);

CREATE TABLE IF NOT EXISTS file_stats (
	fileid TEXT PRIMARY KEY,
	request_count INTEGER,
	bytes_sent INTEGER,
	last_seen_ts INTEGER
);

CREATE TABLE IF NOT EXISTS ip_stats (
	ip TEXT PRIMARY KEY,
	request_count INTEGER,
	bytes_sent INTEGER,
	last_seen_ts INTEGER
);
