#!/usr/bin/env bash
set -euo pipefail

FILE=".env.local"
[ -f "$FILE" ] || cp .env.example "$FILE"

if grep -q '^POSTGRES_PASSWORD=' "$FILE"; then
  echo "Ya existen las claves locales en $FILE. No se cambió nada."
  exit 0
fi

SUPER=$(openssl rand -hex 24)
OWNER=$(openssl rand -hex 24)
APPPW=$(openssl rand -hex 24)
KEY=$(openssl rand -base64 32)

sed -i '/^DATABASE_URL=/d' "$FILE"

cat >> "$FILE" <<EOT

# --- Base de datos local (generado por scripts/gen-local-env.sh) ---
POSTGRES_DB=saas
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$SUPER
APP_OWNER_PASSWORD=$OWNER
APP_USER_PASSWORD=$APPPW
DATABASE_URL=postgresql://app_user:$APPPW@127.0.0.1:5432/saas
MIGRATION_DATABASE_URL=postgresql://app_owner:$OWNER@127.0.0.1:5432/saas
DB_POOL_MAX=10
DB_SSL=false
ENCRYPTION_KEY_1=$KEY
ENCRYPTION_CURRENT_VERSION=1
EOT

echo "✔ Claves locales generadas en $FILE (no se suben a git)."
