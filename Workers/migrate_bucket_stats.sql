-- D1 migration for hourly bucketed stats.
-- Run this once on existing deployments before using the bucketed Worker.

ALTER TABLE file_stats ADD COLUMN bucket_ts INTEGER DEFAULT 0;
ALTER TABLE ip_stats ADD COLUMN bucket_ts INTEGER DEFAULT 0;

UPDATE file_stats
   SET bucket_ts = CAST(last_seen_ts / 3600 AS INTEGER) * 3600
 WHERE bucket_ts = 0
   AND last_seen_ts > 0;

UPDATE ip_stats
   SET bucket_ts = CAST(last_seen_ts / 3600 AS INTEGER) * 3600
 WHERE bucket_ts = 0
   AND last_seen_ts > 0;

CREATE TABLE file_stats_new (
	client_ip TEXT,
	fileid TEXT,
	bucket_ts INTEGER,
	request_count INTEGER,
	bytes_sent INTEGER,
	last_seen_ts INTEGER,
	PRIMARY KEY (client_ip, fileid, bucket_ts)
);

INSERT INTO file_stats_new (client_ip, fileid, bucket_ts, request_count, bytes_sent, last_seen_ts)
SELECT client_ip, fileid, bucket_ts, request_count, bytes_sent, last_seen_ts
  FROM file_stats;

DROP TABLE file_stats;
ALTER TABLE file_stats_new RENAME TO file_stats;

CREATE INDEX IF NOT EXISTS file_stats_client_range_idx ON file_stats (client_ip, bucket_ts DESC);

CREATE TABLE ip_stats_new (
	client_ip TEXT,
	requester_ip TEXT,
	bucket_ts INTEGER,
	request_count INTEGER,
	bytes_sent INTEGER,
	last_seen_ts INTEGER,
	PRIMARY KEY (client_ip, requester_ip, bucket_ts)
);

INSERT INTO ip_stats_new (client_ip, requester_ip, bucket_ts, request_count, bytes_sent, last_seen_ts)
SELECT client_ip, requester_ip, bucket_ts, request_count, bytes_sent, last_seen_ts
  FROM ip_stats;

DROP TABLE ip_stats;
ALTER TABLE ip_stats_new RENAME TO ip_stats;

CREATE INDEX IF NOT EXISTS ip_stats_client_range_idx ON ip_stats (client_ip, bucket_ts DESC);
