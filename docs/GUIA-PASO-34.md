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
