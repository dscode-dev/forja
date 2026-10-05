#!/bin/bash
set -euo pipefail
# Root preparation only; the official entrypoint runs PostgreSQL as postgres.
# Keep host secret files 0600 and provide init-only postgres-owned copies in tmpfs.
install -d -m 0700 -o postgres -g postgres /run/forja-init-secrets
for name in api-password migration-password; do
  install -m 0600 -o postgres -g postgres "/run/secrets/$name" "/run/forja-init-secrets/$name"
done
exec /usr/local/bin/docker-entrypoint.sh "$@"
