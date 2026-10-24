#!/usr/bin/env bash
# Restaura un respaldo en la base de datos ACTUAL (la reemplaza). Uso:  bash deploy/restaurar.sh /var/backups/saas/saas-XXXX.sql.gz
. "$(dirname "$0")/_comun.sh"
ARCH="${1:-}"; [ -f "$ARCH" ] || { echo "Uso: bash deploy/restaurar.sh <archivo.sql.gz>"; exit 1; }
gzip -t "$ARCH" || { echo "✖ El archivo está dañado."; exit 1; }
read -r -p "Esto BORRA los datos actuales y pone los del respaldo. Escribe RESTAURAR para continuar: " R
[ "$R" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }
dc stop app worker
dc exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS saas_restaurando" -c "CREATE DATABASE saas_restaurando OWNER app_owner" -c "REVOKE ALL ON DATABASE saas_restaurando FROM PUBLIC" -c "GRANT CONNECT ON DATABASE saas_restaurando TO app_owner, app_user"'
gzip -dc "$ARCH" | dc exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d saas_restaurando'
dc exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'saas'"'"'" -c "ALTER DATABASE saas RENAME TO saas_anterior" -c "ALTER DATABASE saas_restaurando RENAME TO saas"'
dc up -d app worker
esperar_app
echo "✔ Restaurado. La base anterior quedó como «saas_anterior» (bórrala cuando confirmes que todo está bien):"
echo "   docker compose -f docker-compose.prod.yml --env-file .env.production exec db psql -U postgres -c 'DROP DATABASE saas_anterior'"
