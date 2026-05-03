DO $$
BEGIN
    -- 1. Add bucket_ts columns if they do not exist.
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'file_stats'
          AND column_name = 'bucket_ts'
    ) THEN
        ALTER TABLE file_stats ADD COLUMN bucket_ts BIGINT NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'ip_stats'
          AND column_name = 'bucket_ts'
    ) THEN
        ALTER TABLE ip_stats ADD COLUMN bucket_ts BIGINT NOT NULL DEFAULT 0;
    END IF;

    -- 2. Backfill existing all-time rows into the hour bucket that contains
    -- their last seen timestamp, so range queries can still see migrated data.
    UPDATE file_stats
       SET bucket_ts = (last_seen_ts / 3600) * 3600
     WHERE bucket_ts = 0
       AND last_seen_ts > 0;

    UPDATE ip_stats
       SET bucket_ts = (last_seen_ts / 3600) * 3600
     WHERE bucket_ts = 0
       AND last_seen_ts > 0;

    -- 3. Update file_stats primary key.
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'file_stats_pkey'
    ) THEN
        ALTER TABLE file_stats DROP CONSTRAINT file_stats_pkey;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'file_stats_new_pkey'
    ) THEN
        ALTER TABLE file_stats
            ADD CONSTRAINT file_stats_new_pkey PRIMARY KEY (client_ip, fileid, bucket_ts);
    END IF;

    -- 4. Update ip_stats primary key.
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ip_stats_pkey'
    ) THEN
        ALTER TABLE ip_stats DROP CONSTRAINT ip_stats_pkey;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ip_stats_new_pkey'
    ) THEN
        ALTER TABLE ip_stats
            ADD CONSTRAINT ip_stats_new_pkey PRIMARY KEY (client_ip, requester_ip, bucket_ts);
    END IF;

    -- 5. Create range query indexes.
    CREATE INDEX IF NOT EXISTS file_stats_client_range_idx
        ON file_stats (client_ip, bucket_ts DESC);

    CREATE INDEX IF NOT EXISTS ip_stats_client_range_idx
        ON ip_stats (client_ip, bucket_ts DESC);
END $$;
