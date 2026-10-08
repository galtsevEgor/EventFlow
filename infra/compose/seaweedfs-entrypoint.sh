#!/bin/sh
set -eu

umask 077
install -m 0400 -o seaweed -g seaweed /etc/seaweedfs/s3.json /run/eventflow-s3/s3.json

exec /entrypoint.sh "$@"
