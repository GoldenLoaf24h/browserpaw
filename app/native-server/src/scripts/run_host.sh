#!/bin/sh
set -eu
host_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
export BROWSERPAW_HOME="$(dirname -- "$host_dir")"
IFS= read -r node_path < "$host_dir/node_path.txt" || [ -n "$node_path" ]
exec "$node_path" "$host_dir/host.cjs" "$@"
