#!/usr/bin/env bash
# Construye la imagen, aplica migraciones y enciende todo (base de datos, Redis, web, worker y túnel).
# Uso:  bash deploy/arrancar.sh
. "$(dirname "$0")/_comun.sh"
echo "▶ Construyendo la imagen (la primera vez tarda unos minutos)…"
dc build
echo "▶ Encendiendo…"
dc up -d
esperar_app
if grep -q '^COMPOSE_PROFILES=.*rapido' .env.production; then
  echo "▶ Buscando la dirección temporal del túnel…"
  bash deploy/url-temporal.sh
else
  echo "ℹ Túnel fijo: APP_URL debe ser tu dominio (https://…) en .env.production."
fi
echo
echo "Siguiente: crear tu usuario súper admin →  bash deploy/crear-admin.sh"
