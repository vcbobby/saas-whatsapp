#!/usr/bin/env bash
# Copia de seguridad de la base de datos (comprimida) en /var/backups/saas, conservando las últimas 14.
# Uso manual:  bash deploy/respaldo.sh        Programarla cada noche:  sudo bash deploy/respaldo.sh --programar
# Probar que el último respaldo SÍ se puede restaurar (sin tocar la base real):  bash deploy/respaldo.sh --probar
. "$(dirname "$0")/_comun.sh"
DIR="${BACKUP_DIR:-/var/backups/saas}"
if [ "${1:-}" = "--programar" ]; then
  [ "$(id -u)" = 0 ] || { echo "✖ Usa sudo para programarla."; exit 1; }
  AQUI="$(pwd)"
  {
    echo "30 3 * * * root cd $AQUI && bash deploy/respaldo.sh >> /var/log/saas-respaldo.log 2>&1"
    echo "30 4 * * 0 root cd $AQUI && bash deploy/respaldo.sh --probar >> /var/log/saas-respaldo.log 2>&1"
  } > /etc/cron.d/saas-respaldo
  chmod 644 /etc/cron.d/saas-respaldo
  echo "✔ Respaldo diario a las 3:30 y prueba de restauración los domingos 4:30 (hora del servidor). Archivos en $DIR"
  exit 0
fi
if [ "${1:-}" = "--probar" ]; then
  # Prueba de restauración: carga un respaldo (el último, o el que indiques) en una base TEMPORAL y comprueba que tiene datos.
  # No toca la base real. Un respaldo que nunca se probó no es una garantía.
  ARCH="${2:-$(ls -1t "$DIR"/saas-*.sql.gz 2>/dev/null | head -1 || true)}"
  [ -n "$ARCH" ] && [ -f "$ARCH" ] || { echo "✖ No hay respaldo que probar en $DIR."; exit 1; }
  gzip -t "$ARCH" || { echo "✖ El archivo está dañado: $ARCH"; exit 1; }
  T=saas_prueba_restauracion
  limpiar() { dc exec -T db sh -c "psql -q -U \"\$POSTGRES_USER\" -d postgres -c 'DROP DATABASE IF EXISTS $T'" >/dev/null 2>&1 || true; }
  trap limpiar EXIT
  echo "▶ Probando $ARCH …"
  dc exec -T db sh -c "psql -v ON_ERROR_STOP=1 -q -U \"\$POSTGRES_USER\" -d postgres -c 'DROP DATABASE IF EXISTS $T' -c 'CREATE DATABASE $T OWNER app_owner'"
  gzip -dc "$ARCH" | dc exec -T db sh -c "psql -v ON_ERROR_STOP=1 -q -U \"\$POSTGRES_USER\" -d $T" >/dev/null
  MIG=$(dc exec -T db sh -c "psql -tA -U \"\$POSTGRES_USER\" -d $T -c 'SELECT count(*) FROM schema_migrations'" | tr -d '[:space:]')
  TAB=$(dc exec -T db sh -c "psql -tA -U \"\$POSTGRES_USER\" -d $T -c \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'\"" | tr -d '[:space:]')
  [ "${MIG:-0}" -ge 1 ] && [ "${TAB:-0}" -ge 5 ] || { echo "✖ El respaldo se cargó pero parece vacío (migraciones: ${MIG:-?}, tablas: ${TAB:-?})."; exit 1; }
  echo "✔ El respaldo se restaura bien: $MIG migraciones y $TAB tablas."
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
