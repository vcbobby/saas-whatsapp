#!/usr/bin/env bash
# Lee la dirección https://….trycloudflare.com del túnel rápido y la guarda como APP_URL (reiniciando web y worker si cambió).
# Cada vez que el túnel se reinicia la dirección CAMBIA: ejecuta este script y actualiza la URL del webhook en Meta.
. "$(dirname "$0")/_comun.sh"
URL=""
for i in $(seq 1 30); do
  URL=$(dc logs --no-log-prefix tunel-rapido 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$URL" ] && break
  sleep 2
done
[ -n "$URL" ] || { echo "✖ No encontré la dirección del túnel. Mira:  docker compose -f docker-compose.prod.yml --env-file .env.production logs tunel-rapido"; exit 1; }
ACTUAL=$(grep '^APP_URL=' .env.production | cut -d= -f2-)
if [ "$ACTUAL" != "$URL" ]; then
  sed -i "s#^APP_URL=.*#APP_URL=$URL#" .env.production
  echo "▶ Nueva dirección: $URL — reiniciando web y worker para que la usen…"
  dc up -d --force-recreate app worker
  esperar_app
fi
echo
echo "✔ Tu dirección temporal:  $URL"
echo "  Webhook de WhatsApp (pégalo en Meta):  $URL/api/webhooks/whatsapp"
