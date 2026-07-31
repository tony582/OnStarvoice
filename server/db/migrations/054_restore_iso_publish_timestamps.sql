-- `parsePublishTimestamp` previously matched the YYYY-MM-DD prefix of an
-- ISO 8601 timestamp before Date.parse could see its time and offset. That
-- exact failure mode stored the date prefix as Shanghai midnight.
--
-- Repair only rows that match the old parser output exactly. Do not touch
-- date-only values, ambiguous strings, already-correct timestamps, or manual
-- publish-time overrides.

WITH strict_iso_candidates AS MATERIALIZED (
  SELECT
    record.id,
    record.publish_time::timestamptz AS source_timestamp,
    (
      substring(record.publish_time, 1, 10)::date::timestamp
      AT TIME ZONE 'Asia/Shanghai'
    ) AS old_parser_timestamp
  FROM records record
  WHERE record.publish_time ~*
    '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
    AND record.published_ts IS NOT NULL
    AND NOT (
      COALESCE(record.manual_overrides, '{}'::jsonb) ? 'publish_time'
    )
),
confirmed_truncations AS (
  SELECT id, source_timestamp, old_parser_timestamp
  FROM strict_iso_candidates
  WHERE source_timestamp <> old_parser_timestamp
)
UPDATE records record
SET published_ts = candidate.source_timestamp
FROM confirmed_truncations candidate
WHERE record.id = candidate.id
  AND record.published_ts = candidate.old_parser_timestamp;
