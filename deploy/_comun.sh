# Funciones compartidas por los scripts de deploy/ (no se ejecuta directamente).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f .env.production ] || { echo "✖ Falta .env.production. Ejecuta primero: bash deploy/generar-env.sh"; exit 1; }
dc() { docker compose -f docker-compose.prod.yml --env-file .env.production "$@"; }
esperar_app() {
  echo "▶ Esperando a que la aplicación responda…"
  for i in $(seq 1 60); do
    CID=$(dc ps -q app 2>/dev/null | head -1)
    if [ -n "$CID" ] && [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CID" 2>/dev/null)" = "healthy" ]; then echo "✔ La aplicación está sana."; return 0; fi
    sleep 5
  done
  echo "✖ La aplicación no quedó sana en 5 minutos. Revisa:  docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=80 app"
  return 1
}
