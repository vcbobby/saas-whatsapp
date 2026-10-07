#!/usr/bin/env bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  -v owner_pw="$APP_OWNER_PASSWORD" \
  -v user_pw="$APP_USER_PASSWORD" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -f /roles/roles.sql
