#!/usr/bin/env bash
# Resumen de salud del servidor en una pantalla: contenedores, base de datos, Redis, worker, disco, memoria y último respaldo.
# Uso:  bash deploy/estado.sh        (termina con código 1 si algo está mal; sirve también para un cron o un monitor)
. "$(dirname "$0")/_comun.sh"
MAL=0
echo "── Contenedores ──"
dc ps --format 'table {{.Service}}\t{{.Status}}' || MAL=1

echo; echo "── Salud de la aplicación (web, base de datos, Redis y worker) ──"
SALIDA=$(dc exec -T app node -e "
fetch('http://127.0.0.1:3000/api/health',{headers:{'x-health-token':process.env.HEALTH_TOKEN||''}})
  .then(async r=>{console.log(r.status+' '+(await r.text()));process.exit(r.ok?0:1)})
  .catch(e=>{console.log('sin respuesta: '+e.message);process.exit(1)})" 2>&1) || MAL=1
echo "$SALIDA"
case "$SALIDA" in *'"worker"'*) ;; *) echo "ℹ Sin detalle: falta HEALTH_TOKEN (16+ caracteres) en .env.production; sin él no se ve el estado del worker.";; esac

echo; echo "── Disco y memoria ──"
df -h / | tail -1 | awk '{print "Disco: usado "$3" de "$2" ("$5")"}'
USO=$(df / | tail -1 | awk '{gsub("%","",$5); print $5}')
[ "$USO" -ge 85 ] && { echo "⚠ El disco pasa del 85 %: limpia con  docker image prune -f  o amplía el disco."; MAL=1; }
free -m | awk '/Mem:/ {print "Memoria: "$3" MB usados de "$2" MB"}'

echo; echo "── Respaldos ──"
DIR="${BACKUP_DIR:-/var/backups/saas}"
ULT=$(ls -1t "$DIR"/saas-*.sql.gz 2>/dev/null | head -1 || true)
if [ -z "$ULT" ]; then
  echo "⚠ No hay ningún respaldo en $DIR. Programa uno:  sudo bash deploy/respaldo.sh --programar"; MAL=1
else
  EDAD_H=$(( ( $(date +%s) - $(stat -c %Y "$ULT") ) / 3600 ))
  echo "Último: $ULT (hace ${EDAD_H} h)"
  [ "$EDAD_H" -gt 30 ] && { echo "⚠ El último respaldo tiene más de 30 horas: revisa /var/log/saas-respaldo.log"; MAL=1; }
fi

echo; echo "APP_URL: $(grep '^APP_URL=' .env.production | cut -d= -f2-)"
[ "$MAL" = 0 ] && echo "✔ Todo bien." || echo "✖ Hay algo que revisar (arriba)."
exit "$MAL"
