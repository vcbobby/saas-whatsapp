#!/usr/bin/env bash
# Prepara un servidor Ubuntu/Debian NUEVO: Docker, firewall, actualizaciones automáticas y memoria de apoyo.
# Ejecútalo UNA vez, como root, desde la carpeta del proyecto:  sudo bash deploy/instalar-servidor.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "✖ Ejecútalo con sudo."; exit 1; }
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) echo "✖ Pensado para Ubuntu o Debian (este es: ${ID:-desconocido})."; exit 1;; esac

echo "▶ Actualizando paquetes…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl openssl ufw unattended-upgrades fail2ban git cron gzip

if ! command -v docker >/dev/null; then
  echo "▶ Instalando Docker (script oficial de get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null || { echo "✖ Docker Compose no quedó instalado."; exit 1; }
systemctl enable --now docker

echo "▶ Firewall: solo SSH entrante (la aplicación sale por el túnel, no necesita puertos abiertos)…"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "▶ Actualizaciones de seguridad automáticas y fail2ban…"
dpkg-reconfigure -f noninteractive unattended-upgrades || true
systemctl enable --now fail2ban

# El modelo de búsqueda y el build necesitan memoria: con poca RAM se crea un archivo de intercambio de 2 GB.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 3500 ] && [ "$(swapon --show --noheadings | wc -l)" = 0 ]; then
  echo "▶ Poca RAM (${MEM_MB} MB): creando 2 GB de intercambio…"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo
echo "✔ Servidor listo (RAM: ${MEM_MB} MB). Siguiente:  bash deploy/generar-env.sh   y luego   bash deploy/arrancar.sh"
[ "$MEM_MB" -lt 1800 ] && echo "⚠ Con menos de 2 GB de RAM la aplicación irá justa; recomendado 4 GB."
exit 0
