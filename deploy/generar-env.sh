#!/usr/bin/env bash
# Crea .env.production con claves aleatorias NUEVAS. No sobrescribe uno existente.
# Uso (desde la carpeta del proyecto):  bash deploy/generar-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=".env.production"
[ -e "$FILE" ] && { echo "✖ Ya existe $FILE. No se cambió nada (bórralo solo si quieres EMPEZAR DE CERO: perderías el acceso a los datos cifrados)."; exit 1; }
command -v openssl >/dev/null || { echo "✖ Falta openssl (apt-get install -y openssl)"; exit 1; }

PG=$(openssl rand -hex 24); OWNER=$(openssl rand -hex 24); APPPW=$(openssl rand -hex 24)
RD=$(openssl rand -hex 24); HEALTH=$(openssl rand -hex 24); KEY=$(openssl rand -base64 32); VERIFY=$(openssl rand -hex 24)

umask 077
cat > "$FILE" <<EOT
# Generado por deploy/generar-env.sh. NO lo subas a git. GUARDA UNA COPIA en un lugar seguro (gestor de contraseñas):
# sin ENCRYPTION_KEY_1 no se pueden leer las claves de WhatsApp guardadas.
APP_ENV=staging
# Lo fija deploy/url-temporal.sh (túnel rápido) o tú (dominio fijo): debe ser la dirección https real.
APP_URL=http://localhost:3000
TRUSTED_PROXY=cloudflare
LEGAL_CONSENT=required
# «rapido» = túnel temporal gratis. «fijo» = túnel con dominio propio (pon TUNNEL_TOKEN).
COMPOSE_PROFILES=rapido
TUNNEL_TOKEN=

POSTGRES_DB=saas
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$PG
APP_OWNER_PASSWORD=$OWNER
APP_USER_PASSWORD=$APPPW
DATABASE_URL=postgresql://app_user:$APPPW@db:5432/saas
MIGRATION_DATABASE_URL=postgresql://app_owner:$OWNER@db:5432/saas
DB_POOL_MAX=10
DB_SSL=false

REDIS_PASSWORD=$RD
REDIS_URL=redis://:$RD@redis:6379

ENCRYPTION_KEY_1=$KEY
ENCRYPTION_CURRENT_VERSION=1

# Búsqueda en documentos: modelo local (se descarga una vez, ~120 MB).
EMBEDDINGS_PROVIDER=local
EMBEDDINGS_ALLOW_DOWNLOAD=1
KB_MODEL_DIR=/models

# WhatsApp (Meta). El token de verificación ya está generado; pégalo en Meta al registrar el webhook.
WHATSAPP_VERIFY_TOKEN=$VERIFY
# WHATSAPP_APP_SECRET=   (Meta → Configuración de la app → Básica → Clave secreta)

# Correo (verificación de cuenta, recuperar contraseña, invitaciones, avisos de plan). Con «dev» NADIE recibe correos:
# para testers reales necesitas resend.com + un dominio verificado (guía: deploy/LEEME-SERVIDOR.md, sección «Correo»).
EMAIL_PROVIDER=dev
# EMAIL_API_KEY=
# EMAIL_FROM=Mi App <avisos@tudominio.com>
# EMAIL_REPLY_TO=

# Clave para ver el detalle de salud (web, base de datos, Redis y worker): la usa deploy/estado.sh y puedes ponerla en un monitor
# (cabecera «x-health-token»). Sin ella, /api/health solo dice ok o degraded.
HEALTH_TOKEN=$HEALTH

# Registro de WhatsApp dentro de la app (Inicio de sesión para empresas). Déjalo apagado hasta tener ese acceso en Meta.
# EMBEDDED_SIGNUP_ENABLED=true
# META_APP_ID=
# META_ES_CONFIG_ID=

# IA real (paso 25). Hasta entonces el asistente NO responde en el servidor (el modo de prueba no se permite fuera de tu PC).
# LLM_PROVIDER=gemini
# LLM_MODEL=
# LLM_API_KEY=

# Datos de marca (se incorporan al construir la imagen; si los cambias, ejecuta deploy/actualizar.sh).
# NEXT_PUBLIC_APP_NAME=
# NEXT_PUBLIC_APP_DOMAIN=
# NEXT_PUBLIC_SUPPORT_EMAIL=
# NEXT_PUBLIC_LEGAL_NAME=
# NEXT_PUBLIC_LEGAL_ADDRESS=
# NEXT_PUBLIC_LEGAL_COUNTRY=
# NEXT_PUBLIC_LEGAL_REVIEWED=
EOT
chmod 600 "$FILE"
echo "✔ Creado $FILE (permisos 600). Guarda una copia de ese archivo fuera del servidor."
