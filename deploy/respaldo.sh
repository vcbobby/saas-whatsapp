#!/usr/bin/env bash
# Copia de seguridad de la base de datos (comprimida) en /var/backups/saas, conservando las últimas 14.
# Uso manual:  bash deploy/respaldo.sh        Programarla cada noche:  sudo bash deploy/respaldo.sh --programar
. "$(dirname "$0")/_comun.sh"
DIR="${BACKUP_DIR:-/var/backups/saas}"
if [ "${1:-}" = "--programar" ]; then
  [ "$(id -u)" = 0 ] || { echo "✖ Usa sudo para programarla."; exit 1; }
  AQUI="$(pwd)"
  echo "30 3 * * * root cd $AQUI && bash deploy/respaldo.sh >> /var/log/saas-respaldo.log 2>&1" > /etc/cron.d/saas-respaldo
  chmod 644 /etc/cron.d/saas-respaldo
  echo "✔ Respaldo diario a las 3:30 (hora del servidor). Archivos en $DIR"
  exit 0
fi
mkdir -p "$DIR"; chmod 700 "$DIR"
ARCH="$DIR/saas-$(date +%Y%m%d-%H%M%S).sql.gz"
dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=plain' | gzip -9 > "$ARCH.tmp"
# Un respaldo vacío o truncado no sirve: se valida antes de aceptarlo.
if ! gzip -t "$ARCH.tmp" || [ "$(gzip -dc "$ARCH.tmp" | wc -c)" -lt 1000 ]; then rm -f "$ARCH.tmp"; echo "✖ El respaldo salió vacío o dañado."; exit 1; fi
mv "$ARCH.tmp" "$ARCH"; chmod 600 "$ARCH"
ls -1t "$DIR"/saas-*.sql.gz | tail -n +15 | xargs -r rm -f
echo "✔ Respaldo: $ARCH ($(du -h "$ARCH" | cut -f1))"
echo "⚠ Cópialo FUERA del servidor (tu PC, otro proveedor): si el servidor se pierde, se pierde también el respaldo."
