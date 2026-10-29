#!/usr/bin/env bash
# Baja la última versión del código (git pull), hace un respaldo, reconstruye y reinicia con migraciones.
. "$(dirname "$0")/_comun.sh"
[ -d .git ] && { echo "▶ Descargando cambios…"; git pull --ff-only; }
# Instalaciones anteriores no tienen HEALTH_TOKEN: se crea una vez (sin tocar nada más del archivo).
if ! grep -q '^HEALTH_TOKEN=' .env.production; then
  printf '\nHEALTH_TOKEN=%s\n' "$(openssl rand -hex 24)" >> .env.production
  echo "✔ Se añadió HEALTH_TOKEN a .env.production (detalle de salud para deploy/estado.sh)."
fi
echo "▶ Respaldo previo…"; bash deploy/respaldo.sh
dc build
dc up -d
esperar_app
grep -q '^COMPOSE_PROFILES=.*rapido' .env.production && bash deploy/url-temporal.sh
echo "✔ Actualizado."
bash deploy/estado.sh || true
