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
