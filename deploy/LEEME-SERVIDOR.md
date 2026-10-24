# Montar la aplicación en un servidor (paso 24)

Objetivo: tenerla en internet con una dirección **https temporal y gratis** (túnel de Cloudflare) para probar con otras personas.

## 0. Qué necesitas
- Un **VPS** con Ubuntu 22.04 o 24.04 y acceso `root`/`sudo` por SSH. Recomendado **4 GB de RAM** (mínimo 2 GB + el archivo de intercambio que crea el instalador). Sirve un VPS de Hostinger, Contabo, Hetzner, DigitalOcean, etc.
- **No sirve el "hosting web compartido" (Premium/Business)**: no permite Docker, ni Redis, ni PostgreSQL con pgvector, ni procesos que queden corriendo.
- Tu código en GitHub (puede ser privado) y un correo para tu usuario súper admin.

## 1. Entrar al servidor y traer el código
```bash
ssh root@IP_DEL_SERVIDOR
git clone https://github.com/TU_USUARIO/TU_REPO.git saas-whatsapp      # repo privado: usa un token de solo lectura
cd saas-whatsapp
```
(Repo privado: GitHub → Settings → Developer settings → Fine-grained tokens → permiso "Contents: Read-only" solo para ese repo; la contraseña que pide `git` es el token.)

## 2. Preparar el servidor (una sola vez)
```bash
sudo bash deploy/instalar-servidor.sh
```
Instala Docker, deja el firewall solo con SSH, activa actualizaciones de seguridad y fail2ban.

## 3. Crear las claves y arrancar
```bash
bash deploy/generar-env.sh      # crea .env.production con claves aleatorias nuevas
nano .env.production            # opcional: descomenta y llena NEXT_PUBLIC_APP_NAME, etc.
bash deploy/arrancar.sh         # construye (varios minutos), migra y enciende; al final muestra tu dirección https
bash deploy/crear-admin.sh      # tu usuario súper admin (correo + contraseña de 16+ caracteres)
```
**Guarda una copia de `.env.production` fuera del servidor** (gestor de contraseñas). Sin `ENCRYPTION_KEY_1` no se pueden leer las claves de WhatsApp guardadas.

Abre la dirección que mostró (`https://algo.trycloudflare.com`), entra con tu súper admin y activa la verificación en dos pasos.

## 4. Conectar WhatsApp (Meta)
- Webhook: `https://TU-DIRECCION/api/webhooks/whatsapp`
- Token de verificación: el valor de `WHATSAPP_VERIFY_TOKEN` en `.env.production`
- Clave de la app: pon `WHATSAPP_APP_SECRET=…` en `.env.production` y ejecuta `bash deploy/actualizar.sh`.

## 5. La dirección temporal cambia
El túnel rápido de Cloudflare **cambia de dirección cada vez que se reinicia** (reinicio del servidor, `docker compose down`…). Si pasa: `bash deploy/url-temporal.sh` (actualiza la aplicación) y **vuelve a poner el webhook en Meta**. Cloudflare no garantiza su disponibilidad: es para pruebas, no para clientes.

Para una dirección **fija y gratis** (túnel con nombre) necesitas un dominio (≈1–10 USD/año) agregado a Cloudflare:
1. Cloudflare → Zero Trust → Networks → Tunnels → crear túnel → copia el **token**.
2. En ese túnel, "Public hostname": `app.TUDOMINIO.com` → servicio `http://app:3000`.
3. En `.env.production`: `COMPOSE_PROFILES=fijo`, `TUNNEL_TOKEN=…` y `APP_URL=https://app.TUDOMINIO.com`.
4. `bash deploy/actualizar.sh` (y apaga el túnel rápido: `docker compose -f docker-compose.prod.yml --env-file .env.production rm -sf tunel-rapido`).

## 6. Día a día
| Quiero… | Comando |
|---|---|
| Ver el estado | `docker compose -f docker-compose.prod.yml --env-file .env.production ps` |
| Ver errores de la web / worker | `… logs --tail=100 app` / `… logs --tail=100 worker` |
| Actualizar a lo último de GitHub | `bash deploy/actualizar.sh` (hace respaldo antes) |
| Respaldo ahora | `bash deploy/respaldo.sh` |
| Respaldo automático cada noche | `sudo bash deploy/respaldo.sh --programar` |
| Restaurar | `bash deploy/restaurar.sh /var/backups/saas/ARCHIVO.sql.gz` |
| Comprobar que está vivo (monitor externo) | `GET https://TU-DIRECCION/api/health` → `{"status":"ok"}` |

**Los respaldos viven en el mismo servidor**: copia el archivo a tu PC (o a otro proveedor) con regularidad y **prueba restaurar** al menos una vez.

## 7. Límites de esta versión
- Hasta el paso 25 (IA real) el asistente **no responde** en el servidor: el modo de prueba está prohibido fuera de tu PC. La web, el panel, los documentos, los cobros y la tasa funcionan.
- La búsqueda en documentos descarga un modelo (~120 MB) la primera vez que se indexa un documento.
- No hay correos automáticos todavía (alertas y soporte se ven solo en pantalla).
