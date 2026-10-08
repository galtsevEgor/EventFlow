#!/bin/sh
set -eu

umask 077
mkdir -p /etc/seaweedfs
printf '%s' '{"identities":[{"name":"fixture","credentials":[{"accessKey":"fixture-access","secretKey":"fixture-secret"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' > /etc/seaweedfs/s3.json
chown 1001:1001 /etc/seaweedfs/s3.json
chmod 0600 /etc/seaweedfs/s3.json
if su-exec seaweed test -r /etc/seaweedfs/s3.json; then
  echo 'The private runner-owned fixture must not be readable by SeaweedFS.' >&2
  exit 1
fi

"$@" > /tmp/s3-startup.log 2>&1 &
server=$!
trap 'kill -KILL "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT

for attempt in $(seq 1 30); do
  if ! kill -0 "$server" 2>/dev/null; then
    tail -n 10 /tmp/s3-startup.log >&2
    exit 1
  fi
  wget -S -O /dev/null http://127.0.0.1:8333/ 2> /tmp/s3-response.log || true
  if grep -q '403 Forbidden' /tmp/s3-response.log; then
    test "$(awk '/^Uid:/ { print $2 }' /proc/"$server"/status)" = 1000
    test "$(stat -c '%u:%a' /etc/seaweedfs/s3.json)" = 1001:600
    test "$(stat -c '%u:%a' /run/eventflow-s3/s3.json)" = 1000:400
    su-exec seaweed test -r /run/eventflow-s3/s3.json
    if su-exec seaweed test -w /run/eventflow-s3/s3.json; then
      echo 'SeaweedFS must not be able to modify its credentials.' >&2
      exit 1
    fi
    echo 'Unprivileged S3 is ready; runner credentials remain private.'
    exit 0
  fi
  sleep 1
done

tail -n 10 /tmp/s3-startup.log >&2
exit 1
