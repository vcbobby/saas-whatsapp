#!/usr/bin/env bash
# Baja la última versión del código (git pull), hace un respaldo, reconstruye y reinicia con migraciones.
. "$(dirname "$0")/_comun.sh"
[ -d .git ] && { echo "▶ Descargando cambios…"; git pull --ff-only; }
echo "▶ Respaldo previo…"; bash deploy/respaldo.sh
dc build
dc up -d
esperar_app
grep -q '^COMPOSE_PROFILES=.*rapido' .env.production && bash deploy/url-temporal.sh
echo "✔ Actualizado."
