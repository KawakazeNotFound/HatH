CREATE TABLE IF NOT EXISTS clients (
	client_ip TEXT PRIMARY KEY,
	name TEXT,
	cache_url TEXT,
	last_seen_ts INTEGER,
	timeout_s INTEGER,
	uptime_s INTEGER,
	files_sent INTEGER,
	bytes_sent INTEGER,
	cache_count INTEGER,
	cache_size INTEGER,
	open_connections INTEGER
);

CREATE TABLE IF NOT EXISTS file_stats (
	client_ip TEXT,
	fileid TEXT,
	bucket_ts INTEGER,
	request_count INTEGER,
	bytes_sent INTEGER,
	last_seen_ts INTEGER,
	PRIMARY KEY (client_ip, fileid, bucket_ts)
);

CREATE INDEX IF NOT EXISTS file_stats_client_range_idx ON file_stats (client_ip, bucket_ts DESC);

CREATE TABLE IF NOT EXISTS ip_stats (
	client_ip TEXT,
	requester_ip TEXT,
	bucket_ts INTEGER,
	request_count INTEGER,
	bytes_sent INTEGER,
	last_seen_ts INTEGER,
	PRIMARY KEY (client_ip, requester_ip, bucket_ts)
);

CREATE INDEX IF NOT EXISTS ip_stats_client_range_idx ON ip_stats (client_ip, bucket_ts DESC);
