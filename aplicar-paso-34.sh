#!/usr/bin/env bash
# Paso 34: despliegue listo (CI, estado, latido del worker, respaldos probados).
# Ejecútalo desde la raíz del proyecto:  bash aplicar-paso-34.sh
set -euo pipefail

[ -f package.json ] && grep -q '"name": "saas-whatsapp"' package.json || { echo "✖ Ejecuta esto dentro de ~/proyectos/saas-whatsapp"; exit 1; }
[ -f db/migrations/0045_sin_respuesta.sql ] || { echo "✖ Falta el Paso 33. Aplícalo primero."; exit 1; }
[ -f src/lib/automations/tick.ts ] || { echo "✖ Faltan las automatizaciones por tiempo."; exit 1; }
command -v npm >/dev/null || { echo "✖ No encuentro npm"; exit 1; }

if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ]; then
  git checkout -b paso-34 2>/dev/null || git checkout paso-34
  echo "✔ Rama paso-34 lista"
fi

BK=".paso34-backup"
mkdir -p "$BK"
backup() { if [ -f "$1" ]; then mkdir -p "$BK/$(dirname "$1")"; cp "$1" "$BK/$1"; fi; }
grep -q "^.paso34-backup" .gitignore 2>/dev/null || printf "\n.paso34-backup/\n" >> .gitignore
backup ".github/workflows/ci.yml"
backup ".gitleaks.toml"
backup "deploy/LEEME-SERVIDOR.md"
backup "deploy/estado.sh"
backup "deploy/respaldo.sh"
backup "deploy/generar-env.sh"
backup "deploy/actualizar.sh"
backup "src/lib/queue/heartbeat.ts"
backup "src/app/api/health/route.ts"
backup "src/worker/index.ts"
backup "tests/health.test.ts"
backup "docs/GUIA-PASO-34.md"

mkdir -p ".github/workflows"
cat > ".github/workflows/ci.yml" <<'EOF__GITHUB_WORKFLOWS_CI_YML'
# Revisión automática en GitHub: cada push a main y cada Pull Request corre tipos, estilo, pruebas, compilación y búsqueda de secretos.
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  pruebas:
    name: Tipos, estilo y pruebas
    runs-on: ubuntu-latest
    timeout-minutes: 25
    services:
      db:
        image: pgvector/pgvector:pg17
        env:
          POSTGRES_PASSWORD: ci-super
          POSTGRES_DB: saas
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres -d saas"
          --health-interval 5s --health-timeout 3s --health-retries 20
      redis:
        image: redis:7.4-alpine
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping" --health-interval 5s --health-timeout 3s --health-retries 20
    env:
      APP_ENV: test
      APP_URL: http://localhost:3000
      DATABASE_URL: postgresql://app_user:ci-user@127.0.0.1:5432/saas
      MIGRATION_DATABASE_URL: postgresql://app_owner:ci-owner@127.0.0.1:5432/saas
      REDIS_URL: redis://127.0.0.1:6379
      DB_POOL_MAX: "10"
      DB_SSL: "false"
      ENCRYPTION_CURRENT_VERSION: "1"
      LLM_PROVIDER: mock
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - name: Clave de cifrado temporal (solo para esta ejecución)
        run: echo "ENCRYPTION_KEY_1=$(openssl rand -base64 32)" >> "$GITHUB_ENV"
      - name: Roles y extensión de la base de datos (igual que en el servidor)
        env:
          PGPASSWORD: ci-super
        run: |
          psql -h 127.0.0.1 -U postgres -d saas -v ON_ERROR_STOP=1 \
            -v owner_pw=ci-owner -v user_pw=ci-user -f db/roles.sql
          psql -h 127.0.0.1 -U postgres -d saas -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector"
      - run: node scripts/migrate.mjs
      - run: npx next typegen
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test

  compilacion:
    name: Compilación de producción
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      # Igual que el Dockerfile: la compilación no necesita base de datos ni claves.
      - run: npm run build

  imagen:
    name: Imagen Docker
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - name: Construir la imagen (la misma que usará el servidor)
        run: docker build -t saas-whatsapp:ci .
      - name: Validar docker-compose.prod.yml con un .env de muestra
        run: |
          bash deploy/generar-env.sh
          docker compose -f docker-compose.prod.yml --env-file .env.production config -q
          COMPOSE_PROFILES=fijo docker compose -f docker-compose.prod.yml --env-file .env.production config -q
      - name: Revisar la sintaxis de los scripts de deploy
        run: for f in deploy/*.sh; do bash -n "$f"; done

  secretos:
    name: Búsqueda de secretos
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_CONFIG: .gitleaks.toml
EOF__GITHUB_WORKFLOWS_CI_YML
echo "✔ .github/workflows/ci.yml"
if [ -f .gitleaks.toml ]; then echo "ℹ .gitleaks.toml ya existe: no se toca (añade a mano el permiso para tests/auth.test.ts si gitleaks se queja)"; else
cat > ".gitleaks.toml" <<'EOF__GITLEAKS_TOML'
# Configuración de gitleaks (la usan el hook pre-commit y el CI). Extiende las reglas por defecto.
[extend]
useDefault = true

[allowlist]
description = "Contraseñas inventadas que las pruebas automáticas usan a propósito (no son secretos reales)"
paths = ['''(^|/)tests/auth\.test\.ts$''']
EOF__GITLEAKS_TOML
echo "✔ .gitleaks.toml"
fi
mkdir -p "deploy"
cat > "deploy/LEEME-SERVIDOR.md" <<'EOF_DEPLOY_LEEME_SERVIDOR_MD'
# Montar la aplicación en un servidor (pasos 24 y 34)

Objetivo: tenerla **siempre encendida en internet** para que otras personas la prueben durante días, sin depender de tu PC.
Con esta guía, el día que tengas el servidor, la instalación toma **unos 30–40 minutos** (la mayor parte es esperar a que construya).

## 0. Qué necesitas (consíguelo antes)

| Cosa | Para qué | Costo aprox. |
|---|---|---|
| **Un VPS** Ubuntu 22.04/24.04 con acceso SSH | Donde corre todo (web, worker, base de datos, Redis) | 0 USD (Oracle Always Free) o ~4–7 USD/mes |
| **Un dominio** | Dirección fija (`app.tudominio.com`), correos con Resend y el webhook de Meta estable | ~10 USD/año |
| Cuenta en **Cloudflare** (gratis) | Túnel https sin abrir puertos (el dominio se agrega ahí) | 0 |
| Cuenta en **Resend** (gratis) | Correos reales (verificar cuenta, recuperar contraseña, invitaciones) | 0 (plan gratuito) |
| Clave de **Gemini** | Que el asistente responda | según uso |
| Tu código en **GitHub** | Para traerlo al servidor | 0 |

**Qué VPS elegir**
- **Oracle Cloud «Always Free»** es la única opción realmente gratuita y siempre encendida: una máquina ARM (Ampere A1, hasta 4 CPU y 24 GB de RAM). Pide tarjeta para verificar (no cobra si te quedas en lo gratuito), a veces dice «Out of capacity» (se reintenta otro día u otra región) y Oracle puede reclamar máquinas gratuitas casi sin uso: **haz respaldos fuera del servidor**. Al crearla elige imagen **Ubuntu 24.04**, forma **VM.Standard.A1.Flex** (2–4 CPU, 12–24 GB) y descarga la llave SSH que te da.
- **VPS barato de pago** (Hetzner, Contabo, Hostinger VPS, DigitalOcean…): 2 CPU y **4 GB de RAM** bastan. Más predecible que Oracle gratis.
- **No sirve** el «hosting compartido» (no permite Docker ni procesos permanentes), ni Vercel/Render gratis (el worker se duerme o no existe).
- La imagen funciona en procesadores Intel/AMD y ARM.

## 1. Entrar al servidor y traer el código (5 min)
```bash
ssh root@IP_DEL_SERVIDOR         # en Oracle el usuario es «ubuntu»:  ssh -i llave.key ubuntu@IP   y luego  sudo -i
git clone https://github.com/TU_USUARIO/TU_REPO.git saas-whatsapp      # repo privado: usa un token de solo lectura
cd saas-whatsapp
```
(Repo privado: GitHub → Settings → Developer settings → Fine-grained tokens → permiso «Contents: Read-only» solo para ese repo; la contraseña que pide `git` es el token.)

## 2. Preparar el servidor (una sola vez, 5 min)
```bash
sudo bash deploy/instalar-servidor.sh
```
Instala Docker, deja el firewall solo con SSH, activa actualizaciones de seguridad y fail2ban. No se abre ningún puerto web: la app sale por el túnel de Cloudflare.

## 3. Dominio fijo con túnel de Cloudflare (10 min, una sola vez)
1. Agrega tu dominio a Cloudflare (Add site → plan gratis) y cambia los *nameservers* en donde compraste el dominio. Espera a que diga «Active».
2. Cloudflare → **Zero Trust** → Networks → **Tunnels** → Create tunnel (Cloudflared) → nombre `saas` → copia el **token** (texto largo tras `--token`).
3. En ese túnel → **Public hostname** → Subdomain `app`, Domain `tudominio.com`, Service `HTTP` · `app:3000`.
4. Más abajo, en el paso 4, pondrás en `.env.production`:
   `COMPOSE_PROFILES=fijo`, `TUNNEL_TOKEN=…`, `APP_URL=https://app.tudominio.com`.

(Si todavía no tienes dominio puedes arrancar con el túnel temporal: deja `COMPOSE_PROFILES=rapido`. Su dirección **cambia** al reiniciarse y no sirve para pruebas de varios días.)

## 4. Claves y arranque (15–20 min, casi todo espera)
```bash
bash deploy/generar-env.sh      # crea .env.production con claves aleatorias nuevas
nano .env.production            # ajusta lo de abajo y guarda (Ctrl+O, Enter, Ctrl+X)
bash deploy/arrancar.sh         # construye (varios minutos), migra y enciende
bash deploy/crear-admin.sh      # tu usuario súper admin (correo + contraseña de 16+ caracteres)
```
**Lo que debes ajustar en `.env.production`:**
- `COMPOSE_PROFILES=fijo`, `TUNNEL_TOKEN=…`, `APP_URL=https://app.tudominio.com` (paso 3).
- Marca (opcional, se incorpora al construir): `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_DOMAIN`, `NEXT_PUBLIC_SUPPORT_EMAIL`, datos legales.
- IA: `LLM_PROVIDER=gemini`, `LLM_API_KEY=…` (sin esto el asistente no responde en el servidor).
- WhatsApp: `WHATSAPP_APP_SECRET=…` (Meta → Configuración de la app → Básica → Clave secreta).
- Correo (ver sección «Correo»).

Después de editar: `bash deploy/actualizar.sh`.
**Guarda una copia de `.env.production` fuera del servidor** (gestor de contraseñas). Sin `ENCRYPTION_KEY_1` no se pueden leer las claves de WhatsApp guardadas.

Abre `https://app.tudominio.com`, entra con tu súper admin y activa la verificación en dos pasos (obligatoria).

## 5. Correo (Resend, 10 min)
Con `EMAIL_PROVIDER=dev` **nadie recibe correos** (verificación, recuperar contraseña, invitaciones): solo sirve en tu PC.
1. resend.com → Domains → Add domain `tudominio.com` → copia los registros DNS (SPF/DKIM) que te da y créalos en Cloudflare (DNS → Add record; los de correo en «DNS only», nube gris).
2. Espera a que Resend diga «Verified» (minutos a unas horas).
3. Resend → API Keys → crea una con permiso de envío.
4. En `.env.production`:
   ```
   EMAIL_PROVIDER=resend
   EMAIL_API_KEY=re_...
   EMAIL_FROM=Mi App <avisos@tudominio.com>
   EMAIL_REPLY_TO=soporte@tudominio.com     (opcional)
   ```
5. `bash deploy/actualizar.sh`, crea una cuenta de prueba y confirma que llega el correo (revisa también «spam»).

## 6. Conectar WhatsApp (Meta)
- Webhook: `https://app.tudominio.com/api/webhooks/whatsapp`
- Token de verificación: el valor de `WHATSAPP_VERIFY_TOKEN` en `.env.production`
- Con el número de PRUEBA de Meta puedes probar sin verificar tu negocio (solo escribe a números que agregues como destinatarios).

## 7. Comprobar que todo quedó bien (2 min)
```bash
bash deploy/estado.sh
```
Debe terminar con «✔ Todo bien»: contenedores arriba, **web + base de datos + Redis + worker** en `ok`, disco, memoria y respaldo reciente. Es lo primero que ejecutas cuando algo parezca raro.

Monitor externo gratis (UptimeRobot o similar): vigila `https://app.tudominio.com/api/health` (responde `{"status":"ok"}`; 503 si falla la base de datos o Redis). Para vigilar también el worker, el monitor debe enviar la cabecera `x-health-token` con el valor de `HEALTH_TOKEN` de `.env.production`.

## 8. Respaldos (5 min, hazlo el primer día)
```bash
sudo bash deploy/respaldo.sh --programar     # cada noche 3:30 + prueba de restauración los domingos 4:30
bash deploy/respaldo.sh                      # uno ahora
bash deploy/respaldo.sh --probar             # comprueba que el último SÍ se puede restaurar (sin tocar la base real)
```
**Los respaldos viven en el mismo servidor.** Cópialos a tu PC con regularidad, por ejemplo desde tu PC:
```bash
scp -r root@IP_DEL_SERVIDOR:/var/backups/saas ./respaldos-saas
```
Restaurar de verdad (reemplaza los datos actuales; deja la base anterior como `saas_anterior`):
`bash deploy/restaurar.sh /var/backups/saas/ARCHIVO.sql.gz`

## 9. Día a día
| Quiero… | Comando |
|---|---|
| Ver si todo está sano | `bash deploy/estado.sh` |
| Actualizar a lo último de GitHub | `bash deploy/actualizar.sh` (respaldo, construcción, migraciones y reinicio; al final muestra el estado) |
| Errores de la web / del worker | `docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=100 app` (o `worker`) |
| Respaldo ahora / probar el último | `bash deploy/respaldo.sh` / `bash deploy/respaldo.sh --probar` |
| Túnel temporal cambió de dirección | `bash deploy/url-temporal.sh` y actualizar el webhook en Meta |

## 10. Si algo falla
- **`estado.sh` dice worker caído**: `… logs --tail=100 worker`. Suele ser una variable mal puesta; corrígela y `bash deploy/actualizar.sh`. Sin worker no hay respuestas de IA, correos ni avisos (la web sí sigue).
- **La web no abre**: ¿el túnel está arriba? (`estado.sh`, línea del túnel). En Cloudflare el *Public hostname* debe apuntar a `http://app:3000`.
- **«No quedó sana en 5 minutos»** al arrancar: casi siempre falta una variable obligatoria; el log de `app` dice cuál.
- **Se llenó el disco**: `docker image prune -f` borra imágenes viejas.

## 11. Límites de esta versión
- La búsqueda en documentos descarga un modelo (~120 MB) la primera vez que se indexa un documento.
- Un solo servidor: si se cae, la app se detiene hasta que lo levantes (los mensajes de WhatsApp se reintentan por Meta unas horas).
- Que el servidor tenga respaldos no es lo mismo que alta disponibilidad: para clientes de pago más adelante conviene un VPS de pago y monitoreo.
EOF_DEPLOY_LEEME_SERVIDOR_MD
echo "✔ deploy/LEEME-SERVIDOR.md"
mkdir -p "deploy"
cat > "deploy/estado.sh" <<'EOF_DEPLOY_ESTADO_SH'
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
EOF_DEPLOY_ESTADO_SH
echo "✔ deploy/estado.sh"
mkdir -p "deploy"
cat > "deploy/respaldo.sh" <<'EOF_DEPLOY_RESPALDO_SH'
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
EOF_DEPLOY_RESPALDO_SH
echo "✔ deploy/respaldo.sh"
mkdir -p "deploy"
cat > "deploy/generar-env.sh" <<'EOF_DEPLOY_GENERAR_ENV_SH'
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
EOF_DEPLOY_GENERAR_ENV_SH
echo "✔ deploy/generar-env.sh"
mkdir -p "deploy"
cat > "deploy/actualizar.sh" <<'EOF_DEPLOY_ACTUALIZAR_SH'
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
EOF_DEPLOY_ACTUALIZAR_SH
echo "✔ deploy/actualizar.sh"
mkdir -p "src/lib/queue"
cat > "src/lib/queue/heartbeat.ts" <<'EOF_SRC_LIB_QUEUE_HEARTBEAT_TS'
import type IORedis from "ioredis";
import { queuePrefix } from "./connection";

/**
 * Latido del worker: cada pocos segundos escribe la hora en Redis con una caducidad corta.
 * Si el worker se cae o se cuelga, la clave desaparece y la salud detallada lo marca (sin él no hay respuestas de IA,
 * ni correos, ni avisos, ni recordatorios).
 */
export const HEARTBEAT_EVERY_MS = 15_000;
export const HEARTBEAT_TTL_S = 60;
/** Más viejo que esto se considera caído (cuatro latidos perdidos). */
export const HEARTBEAT_STALE_MS = 60_000;

export function heartbeatKey(): string {
  return `${queuePrefix()}:worker:heartbeat`;
}

export async function writeHeartbeat(conn: IORedis, now = Date.now()): Promise<void> {
  await conn.set(heartbeatKey(), String(now), "EX", HEARTBEAT_TTL_S);
}

/** Edad del último latido en ms, o null si no hay (worker apagado, caído o nunca arrancó). */
export async function readHeartbeatAge(conn: IORedis, now = Date.now()): Promise<number | null> {
  const raw = await conn.get(heartbeatKey());
  if (!raw) return null;
  const t = Number(raw);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}
EOF_SRC_LIB_QUEUE_HEARTBEAT_TS
echo "✔ src/lib/queue/heartbeat.ts"
mkdir -p "src/app/api/health"
cat > "src/app/api/health/route.ts" <<'EOF_SRC_APP_API_HEALTH_ROUTE_TS'
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db";
import { jsonResponse, route } from "@/lib/auth/http";
import { createProducerConnection } from "@/lib/queue/connection";
import { HEARTBEAT_STALE_MS, readHeartbeatAge } from "@/lib/queue/heartbeat";

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("tiempo agotado")), ms))]);

/** El detalle solo se entrega con HEALTH_TOKEN configurado (mínimo 16 caracteres) y enviado en la cabecera «x-health-token». */
function detailAllowed(req: Request): boolean {
  const expected = process.env.HEALTH_TOKEN ?? "";
  if (expected.length < 16) return false;
  const got = req.headers.get("x-health-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Estado del servicio, para el healthcheck de Docker y para monitores de disponibilidad.
 * Público a propósito, pero NO revela nada: solo "ok" o "degraded" (y el código HTTP 200 / 503), según base de datos y Redis.
 * Con el token correcto añade el desglose (base de datos, Redis y worker). Ahí, un worker caído también da 503.
 * (El healthcheck de Docker usa la versión pública: un worker caído nunca debe tumbar la web.)
 */
export const GET = route(async (req: Request) => {
  let db = false;
  let redis = false;
  let workerAge: number | null = null;
  try {
    await withTimeout(getPool().query("SELECT 1"), 3_000);
    db = true;
  } catch { /* se informa como degradado */ }
  const conn = createProducerConnection();
  try {
    redis = (await withTimeout(conn.ping(), 3_000)) === "PONG";
    if (redis) workerAge = await withTimeout(readHeartbeatAge(conn), 3_000);
  } catch { /* idem */ } finally {
    conn.disconnect();
  }
  const ok = db && redis;
  if (detailAllowed(req)) {
    const worker = workerAge !== null && workerAge <= HEARTBEAT_STALE_MS;
    const all = ok && worker;
    return jsonResponse(
      {
        status: all ? "ok" : "degraded",
        db: db ? "ok" : "caido",
        redis: redis ? "ok" : "caido",
        worker: worker ? "ok" : "caido",
        workerLatidoHaceSeg: workerAge === null ? null : Math.round(workerAge / 1000),
      },
      all ? 200 : 503,
    );
  }
  return jsonResponse({ status: ok ? "ok" : "degraded" }, ok ? 200 : 503);
});
EOF_SRC_APP_API_HEALTH_ROUTE_TS
echo "✔ src/app/api/health/route.ts"
mkdir -p "src/worker"
cat > "src/worker/index.ts" <<'EOF_SRC_WORKER_INDEX_TS'
import { Worker } from "bullmq";
import { getPool } from "@/lib/db";
import { getEmailEnv, getEmbeddingsEnv, getLlmEnv, getSendMode } from "@/lib/env";
import { QUEUE_NAME, createWorkerConnection, queuePrefix } from "@/lib/queue/connection";
import { closeLockClient } from "@/lib/queue/lock";
import { closeProducer } from "@/lib/queue/producer";
import { processInbound } from "@/lib/queue/process";
import { sweepPending } from "@/lib/queue/sweeper";
import { createInboundHandler, onJobFailed } from "./handler";
import { indexPending } from "./kb";
import { deliverDue } from "@/lib/webhooks/deliver";
import { sendDue } from "@/lib/notifications/send";
import { tickAutomations } from "@/lib/automations/tick";
import { purgeDueTenants } from "@/lib/privacy/deletion";
import { refreshRate } from "@/lib/billing/rate-refresh";
import { queuePlanNotices, sendDueEmails } from "@/lib/email/outbox";
import { HEARTBEAT_EVERY_MS, writeHeartbeat } from "@/lib/queue/heartbeat";

const handler = createInboundHandler();

const CONCURRENCY = 5;
const SWEEP_EVERY_MS = 30_000;

const connection = createWorkerConnection();
const worker = new Worker(QUEUE_NAME, (job) => processInbound(job.data, handler), {
  connection,
  prefix: queuePrefix(),
  concurrency: CONCURRENCY,
});

worker.on("completed", (job, result) => {
  console.log(`[worker] trabajo ${job.id} → ${String(result)}`);
});
worker.on("failed", (job, err) => void onJobFailed(job, err));
worker.on("error", (err) => console.error("[worker] error:", err.message));

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const n = await sweepPending();
    if (n > 0) console.log(`[worker] barrendero: ${n} mensajes pendientes reencolados`);
  } catch (err) {
    console.error("[worker] barrendero falló:", err instanceof Error ? err.message : err);
  } finally {
    sweeping = false;
  }
}
void sweep();
const timer = setInterval(sweep, SWEEP_EVERY_MS);

// Indexado de documentos de la base de conocimiento (cada pocos segundos; la cola vive en Postgres).
const KB_EVERY_MS = 5_000;
let indexing = false;
async function indexKb() {
  if (indexing || closing) return;
  indexing = true;
  try {
    await indexPending();
  } catch (err) {
    console.error("[worker] indexado de conocimiento falló:", err instanceof Error ? err.message : err);
  } finally {
    indexing = false;
  }
}
const kbTimer = setInterval(() => void indexKb(), KB_EVERY_MS);

// Avisos (webhooks) a otros sistemas: la cola vive en Postgres; se revisa cada pocos segundos.
const WEBHOOK_EVERY_MS = 3_000;
let delivering = false;
async function deliverWebhooks() {
  if (delivering || closing) return;
  delivering = true;
  try {
    // Mientras haya entregas vencidas se sigue sin esperar al siguiente turno (hasta un tope por vuelta).
    for (let i = 0; i < 10 && !closing; i++) {
      const c = await deliverDue(5);
      if (c.delivered + c.retry + c.failed + c.skipped === 0) break;
    }
  } catch (err) {
    console.error("[worker] avisos (webhooks) falló:", err instanceof Error ? err.message : err);
  } finally {
    delivering = false;
  }
}
const webhookTimer = setInterval(() => void deliverWebhooks(), WEBHOOK_EVERY_MS);

// Avisos automáticos a clientes por WhatsApp (los crean las reglas de «Automatizaciones»).
const NOTIFY_EVERY_MS = 3_000;
let notifying = false;
async function sendNotifications() {
  if (notifying || closing) return;
  notifying = true;
  try {
    for (let i = 0; i < 10 && !closing; i++) {
      const c = await sendDue(5);
      if (c.sent + c.retry + c.omitted + c.failed + c.skipped === 0) break;
    }
  } catch (err) {
    console.error("[worker] avisos a clientes falló:", err instanceof Error ? err.message : err);
  } finally {
    notifying = false;
  }
}
const notifyTimer = setInterval(() => void sendNotifications(), NOTIFY_EVERY_MS);

// Reglas por tiempo («24 h antes de una cita», «pedido sin confirmar»): se revisan cada 30 s solo los negocios que las usan.
let ticking = false;
async function tickTime() {
  if (ticking || closing) return;
  ticking = true;
  try {
    await tickAutomations();
  } catch (err) {
    console.error("[worker] reglas por tiempo falló:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}
const tickTimer = setInterval(() => void tickTime(), 15_000);

// Suscripciones: quien no renovó pasa a «pago pendiente» (no responde a clientes hasta que pague). Cada 10 min.
let expiring = false;
async function expireSubs() {
  if (expiring || closing) return;
  expiring = true;
  try {
    const r = await getPool().query("SELECT expire_subscriptions() AS n");
    if (Number(r.rows[0].n) > 0) console.log(`[worker] ${r.rows[0].n} suscripción(es) vencida(s)`);
  } catch (err) {
    console.error("[worker] vencimientos falló:", err instanceof Error ? err.message : err);
  } finally {
    expiring = false;
  }
}
const expireTimer = setInterval(() => void expireSubs(), 600_000);
setTimeout(() => void expireSubs(), 5_000);

// Eliminación de negocios: cuando pasan los 7 días de espera se borra todo de forma definitiva. Cada 10 min.
let purging = false;
async function purgeTenants() {
  if (purging || closing) return;
  purging = true;
  try {
    const n = await purgeDueTenants();
    if (n > 0) console.log(`[worker] ${n} negocio(s) eliminado(s) definitivamente`);
  } catch (err) {
    console.error("[worker] eliminación de negocios falló:", err instanceof Error ? err.message : err);
  } finally {
    purging = false;
  }
}
const purgeTimer = setInterval(() => void purgeTenants(), 600_000);
setTimeout(() => void purgeTenants(), 8_000);

// Tasa BCV automática: solo actúa si el súper admin puso el modo «automático». Cada 30 min.
let refreshingRate = false;
async function refreshRateJob() {
  if (refreshingRate || closing) return;
  refreshingRate = true;
  try {
    const r = await refreshRate();
    if (r.status === "ok") console.log(`[worker] tasa BCV ${r.rate} (${r.source})`);
    else if (r.status === "rejected") console.error(`[worker] tasa BCV ${r.rate} rechazada por cambio brusco (${r.source}); el súper admin debe revisarla`);
    else if (r.status === "failed") console.error("[worker] tasa BCV: ninguna fuente respondió bien:", r.error);
  } catch (err) {
    console.error("[worker] tasa BCV falló:", err instanceof Error ? err.message : err);
  } finally {
    refreshingRate = false;
  }
}
const rateTimer = setInterval(() => void refreshRateJob(), 1_800_000);
setTimeout(() => void refreshRateJob(), 12_000);

// Latido: lo lee /api/health (con token) y deploy/estado.sh para saber que el worker está vivo.
const beat = () => void writeHeartbeat(connection).catch((err) => console.error("[worker] latido falló:", err instanceof Error ? err.message : err));
beat();
const beatTimer = setInterval(beat, HEARTBEAT_EVERY_MS);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[worker] ${signal}: cerrando con calma…`);
  clearInterval(timer);
  clearInterval(kbTimer);
  clearInterval(webhookTimer);
  clearInterval(notifyTimer);
  clearInterval(tickTimer);
  clearInterval(expireTimer);
  clearInterval(purgeTimer);
  clearInterval(rateTimer);
  clearInterval(mailTimer);
  clearInterval(noticeTimer);
  clearInterval(beatTimer);
  try {
    await worker.close();
    await closeProducer();
    await closeLockClient();
    connection.disconnect();
    await getPool().end();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const sendMode = getSendMode();
// Sin IA configurada (por ejemplo, un servidor recién montado) el worker NO se cae: sigue con lo demás (documentos, webhooks,
// vencimientos, tasa, eliminaciones) y el asistente simplemente no responde hasta que se configure LLM_* (falla cerrado).
let llmProvider: string = "sin-configurar";
try {
  llmProvider = getLlmEnv().LLM_PROVIDER;
} catch (err) {
  console.error("[worker] ⚠ IA NO CONFIGURADA: el asistente no responderá hasta que se configure. Detalle:", err instanceof Error ? err.message : err);
}
if (sendMode === "simulate") console.warn("[worker] ⚠ MODO SIMULACIÓN: las respuestas NO se envían a WhatsApp (solo se ven en /simulador).");
if (getEmbeddingsEnv().EMBEDDINGS_PROVIDER === "fake") console.warn("[worker] ⚠ Embeddings de prueba (fake): la búsqueda en documentos solo coincide por palabras, no por significado.");
if (llmProvider === "mock") console.warn("[worker] ⚠ IA en modo de prueba (mock): se responde con un texto fijo, no hay modelo conectado.");
try {
  const em = getEmailEnv();
  if (em.EMAIL_PROVIDER === "dev" && (process.env.APP_ENV === "staging")) console.warn("[worker] ⚠ CORREO EN MODO «dev» en un servidor: nadie recibirá verificaciones, recuperaciones de contraseña ni invitaciones. Configura EMAIL_PROVIDER=resend.");
} catch (err) {
  console.error("[worker] ⚠ Configuración de correo inválida:", err instanceof Error ? err.message : err);
}
console.log(`[worker] listo: escuchando la cola "${QUEUE_NAME}" (concurrencia ${CONCURRENCY})`);

// Correos: envía los pendientes cada 5 s (con reintentos) y cada 10 min prepara avisos de plan/prueba y borra cuerpos viejos.
let mailing = false;
async function mailJob() {
  if (mailing || closing) return;
  mailing = true;
  try {
    const n = await sendDueEmails(20);
    if (n.sent + n.failed + n.retry > 0) console.log(`[worker] correos: ${n.sent} enviado(s), ${n.retry} a reintentar, ${n.failed} fallido(s)`);
  } catch (err) {
    console.error("[worker] correos falló:", err instanceof Error ? err.message : err);
  } finally {
    mailing = false;
  }
}
const mailTimer = setInterval(() => void mailJob(), 5_000);
let noticing = false;
async function noticeJob() {
  if (noticing || closing) return;
  noticing = true;
  try {
    const q = await queuePlanNotices();
    if (q > 0) console.log(`[worker] ${q} aviso(s) por correo en cola`);
    await getPool().query("SELECT email_purge()");
  } catch (err) {
    console.error("[worker] avisos por correo fallaron:", err instanceof Error ? err.message : err);
  } finally {
    noticing = false;
  }
}
const noticeTimer = setInterval(() => void noticeJob(), 600_000);
setTimeout(() => void noticeJob(), 20_000);
EOF_SRC_WORKER_INDEX_TS
echo "✔ src/worker/index.ts"
mkdir -p "tests"
cat > "tests/health.test.ts" <<'EOF_TESTS_HEALTH_TEST_TS'
import { afterAll, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { getPool } from "@/lib/db";

afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await getPool().end(); });

describe("GET /api/health", () => {
  it("responde ok y no revela nada más, sin necesidad de sesión", async () => {
    const res = await health(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("si la base de datos falla responde 503 «degraded» sin mostrar el error", async () => {
    vi.spyOn(getPool(), "query").mockRejectedValueOnce(new Error("password authentication failed for user app_user at 10.0.0.5"));
    const res = await health(new Request("http://localhost/api/health"));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "degraded" });
    expect(text).not.toMatch(/password|10\.0\.0\.5|app_user/);
  });
});

describe("GET /api/health con detalle", () => {
  const TOKEN = "token-de-salud-largo-123";
  const req = (h: Record<string, string> = {}) => new Request("http://localhost/api/health", { headers: h });

  it("sin HEALTH_TOKEN configurado ignora la cabecera y no da detalle", async () => {
    vi.stubEnv("HEALTH_TOKEN", "");
    const body = await (await health(req({ "x-health-token": TOKEN }))).json();
    expect(body).toEqual({ status: "ok" });
  });

  it("con token incorrecto no da detalle", async () => {
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    const body = await (await health(req({ "x-health-token": "otro-token-incorrecto" }))).json();
    expect(body).toEqual({ status: "ok" });
  });

  it("con token correcto y sin latido del worker responde 503 con el desglose", async () => {
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    const { createProducerConnection } = await import("@/lib/queue/connection");
    const { heartbeatKey } = await import("@/lib/queue/heartbeat");
    const c = createProducerConnection();
    await c.del(heartbeatKey());
    c.disconnect();
    const res = await health(req({ "x-health-token": TOKEN }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", db: "ok", redis: "ok", worker: "caido", workerLatidoHaceSeg: null });
  });

  it("con latido reciente responde 200 y worker ok; con latido viejo, caído", async () => {
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    const { createProducerConnection } = await import("@/lib/queue/connection");
    const { writeHeartbeat, heartbeatKey } = await import("@/lib/queue/heartbeat");
    const c = createProducerConnection();
    await writeHeartbeat(c);
    let res = await health(req({ "x-health-token": TOKEN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", worker: "ok" });
    await writeHeartbeat(c, Date.now() - 120_000);
    res = await health(req({ "x-health-token": TOKEN }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ worker: "caido" });
    await c.del(heartbeatKey());
    c.disconnect();
  });

  it("la versión pública sigue dando 200 aunque el worker esté caído", async () => {
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    const res = await health(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
EOF_TESTS_HEALTH_TEST_TS
echo "✔ tests/health.test.ts"
mkdir -p "docs"
cat > "docs/GUIA-PASO-34.md" <<'EOF_DOCS_GUIA_PASO_34_MD'
# Paso 34 — Todo listo para el día que tengas el servidor

Este paso no agrega funciones nuevas a la app: prepara el despliegue para que, cuando consigas el VPS, ponerla en línea tome ~30–40 minutos.

## Qué trae
1. **Guía de servidor reescrita** (`deploy/LEEME-SERVIDOR.md`): qué comprar (Oracle gratis o VPS barato + dominio), túnel fijo de Cloudflare, correo con Resend, WhatsApp, respaldos y qué hacer si algo falla.
2. **`bash deploy/estado.sh`**: una pantalla con contenedores, web + base de datos + Redis + **worker**, disco, memoria y edad del último respaldo. Termina en error si algo está mal.
3. **Latido del worker**: el worker marca «estoy vivo» en Redis cada 15 s. `/api/health` sigue siendo público y mínimo (`ok`/`degraded`), pero con la cabecera `x-health-token` (valor de `HEALTH_TOKEN`) da el desglose y devuelve 503 si el worker lleva más de 60 s sin latir. El healthcheck de Docker usa la versión pública: un worker caído nunca tumba la web.
4. **Respaldos con prueba real**: `bash deploy/respaldo.sh --probar` restaura el último respaldo en una base temporal y comprueba que tiene tablas y migraciones. `--programar` ahora también lo agenda cada domingo.
5. **`deploy/generar-env.sh`** crea `HEALTH_TOKEN` y deja listos (comentados) los ajustes de correo y de registro de WhatsApp. `deploy/actualizar.sh` añade `HEALTH_TOKEN` a instalaciones anteriores y muestra el estado al final.
6. **CI en GitHub** (`.github/workflows/ci.yml`): en cada push a `main` y cada Pull Request corre tipos, lint y pruebas (con Postgres+pgvector y Redis reales), la compilación de producción, la construcción de la imagen Docker con validación del compose, y gitleaks.
7. **`.gitleaks.toml`**: ignora las contraseñas inventadas de `tests/auth.test.ts` (solo se crea si no tenías uno).
8. El worker avisa en su log si está en un servidor con correo en modo `dev`.

## Cómo aplicarlo
```bash
bash aplicar-paso-34.sh
npm run typecheck && npm run lint && npm test
git add -A && git commit -m "Paso 34: despliegue listo" && git push
```
Al hacer push, en GitHub → pestaña **Actions** verás el CI correr. La primera vez puede fallar por detalles que solo se ven en GitHub (ver abajo); pásame el error y lo ajustamos.

## Qué NO está probado (no tengo Docker ni internet en mi entorno)
- La construcción real de la imagen y el arranque de los contenedores. Sí validé `docker compose config`, la sintaxis de todos los scripts y las variables que genera `generar-env.sh`.
- El workflow de GitHub Actions (revisé que el YAML sea válido; la ejecución real solo se verá en GitHub).
- Oracle/Cloudflare/Resend: la guía describe el procedimiento según su funcionamiento habitual; los menús pueden haber cambiado de nombre.

**Sí probado** contra un Postgres real: `respaldo.sh`, `respaldo.sh --probar` (también con un archivo corrupto), `restaurar.sh`, `estado.sh` y `actualizar.sh` (con un «doble» de Docker que ejecuta los comandos de base de datos contra Postgres), más las pruebas automáticas del health con token y latido.
EOF_DOCS_GUIA_PASO_34_MD
echo "✔ docs/GUIA-PASO-34.md"

cat <<'FIN'

══════════════════════════════════════════════════════════
 Paso 34 aplicado (despliegue listo). En TU computadora ahora:

   1) npm run typecheck && npm run lint && npm test
   2) git add -A && git commit y git push: en GitHub → Actions verás el CI.
   3) No hay migración nueva. Cuando tengas el servidor: deploy/LEEME-SERVIDOR.md
   4) Lee docs/GUIA-PASO-34.md.

   Si algo sale mal, tus archivos originales quedaron en .paso34-backup/
══════════════════════════════════════════════════════════
FIN