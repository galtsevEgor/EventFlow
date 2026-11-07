#!/bin/sh
(
  set -eu

  client() {
    clickhouse-client --host 127.0.0.1 --user "$CLICKHOUSE_USER" \
      --password "$CLICKHOUSE_PASSWORD" --max_query_size=1048576 "$@"
  }

  # A changed system-log engine archives the previous table instead of deleting it.
  client --query 'SYSTEM FLUSH LOGS metric_log'
  archives="$(client --query "SELECT name FROM system.tables WHERE database='system' AND match(name, '^metric_log_[0-9]+$') FORMAT TSVRaw")"
  for table in $archives; do
    # Archived tables still merge in the background and need the same memory bound.
    client --query "ALTER TABLE system.\`$table\` MODIFY SETTING vertical_merge_algorithm_min_rows_to_activate=1, vertical_merge_algorithm_min_bytes_to_activate=0"
  done
)
