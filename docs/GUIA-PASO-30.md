# Paso 30 — Correos automáticos

## 1. Qué hay de nuevo
La app ya envía correos sola:
- **Confirmar correo** al registrarse (aviso suave en el panel; no bloquea nada; hay botón «Reenviar correo»).
- **¿Olvidaste tu contraseña?** en la pantalla de entrar → `/recuperar`. El enlace vale **1 hora**, se usa **una sola vez**, y al usarlo se **cierran todas las sesiones** de esa cuenta. La pantalla responde igual exista o no el correo (nadie puede averiguar quién tiene cuenta). Máximo 3 enlaces por hora por cuenta.
- **Invitaciones al equipo**: además de mostrar el enlace (que sigue ahí por si el correo tarda), se envía por correo. Quien se registra con ese enlace queda con el correo verificado.
- **Avisos al dueño del negocio**: la prueba gratis termina en 3 días / terminó, el plan vence en 3 días / venció, pago confirmado, pago rechazado. Cada aviso se manda **una sola vez**.
- **Aviso de contraseña cambiada**.

Los correos pasan por una **cola** (tabla `email_outbox`) que el worker vacía cada 5 segundos, con **reintentos** (1 min, 5 min, 30 min, 2 h, 6 h). Si el proveedor falla, la acción del usuario (registrarse, invitar…) no se rompe.

Seguridad: los enlaces llevan un token aleatorio de 32 bytes; en la base solo queda su **hash**. Con un proveedor real, el texto del correo (que contiene el enlace) **se borra de la cola al enviarse**. La aplicación no puede leer la cola directamente, solo mediante funciones controladas.

## 2. Probar en tu computadora (sin cuenta de correo)
Por defecto `EMAIL_PROVIDER=dev`: no se envía nada real.
1. `npm run db:migrate` (migración `0040_correos.sql`) y reinicia `npm run dev:all` (el worker manda los correos).
2. Registra un usuario o pulsa «¿Olvidaste tu contraseña?».
3. Entra con tu sesión a **http://localhost:3000/dev/correos**: ahí aparecen los correos, con su enlace. En la terminal del worker también se imprime el enlace.
   Esa página **solo existe en desarrollo**; en producción responde 404.

## 3. Enviar correos de verdad con Resend (cuando tengas dominio)
Resend (resend.com) tiene un plan gratis de aproximadamente 3.000 correos al mes (con tope diario); confirma los límites vigentes en su página de precios.

### 3.1. Cuenta y dominio
1. Crea una cuenta en https://resend.com.
2. **Domains → Add Domain**. Escribe tu dominio o, mejor, un subdominio (p. ej. `mail.tudominio.com`).
3. Resend te muestra unos **registros DNS** (normalmente un TXT de **SPF**, un TXT de **DKIM** y un MX). Ve al panel donde compraste el dominio (o Cloudflare si lo administras ahí) → **DNS** → agrega cada registro **exactamente** como aparece (tipo, nombre, valor). En Cloudflare deja la nube en **«Solo DNS» (gris)**.
4. Vuelve a Resend → **Verify DNS Records**. Puede tardar de minutos a unas horas. Cuando diga **Verified**, sigue.
   Sin dominio verificado Resend solo deja enviar pruebas a tu propio correo; por eso este paso va después de elegir dominio.

### 3.2. Clave y variables
1. Resend → **API Keys → Create API Key**, permiso **Sending access**, y limítala a tu dominio. **Cópiala en el momento** (no se vuelve a mostrar).
2. En `.env.local` (o en las variables del servidor):
```
EMAIL_PROVIDER=resend
EMAIL_API_KEY=re_xxxxxxxxxxxxxxxx
EMAIL_FROM=Nombre de tu app <avisos@mail.tudominio.com>
EMAIL_REPLY_TO=soporte@tudominio.com
NEXT_PUBLIC_SUPPORT_EMAIL=soporte@tudominio.com
```
3. Reinicia el worker. **Nunca** pegues la clave en el chat, en el código ni en capturas.
4. Prueba: «¿Olvidaste tu contraseña?» con tu correo real. Debe llegar en segundos; revisa **spam** la primera vez.

En producción (`APP_ENV=production`) la app **se niega a arrancar el envío con `dev`**, para que no pierdas correos sin darte cuenta.

## 4. Si algo falla
- No llega nada: mira la terminal del worker; los errores salen como `[worker] correos…`. Un 401/403 casi siempre es clave equivocada o dominio sin verificar; 422 es remitente no permitido.
- Llega a spam: revisa que SPF y DKIM digan «Verified» en Resend; usa un remitente con tu dominio, no Gmail.
- Los avisos de plan se calculan cada 10 minutos; el primero tarda hasta ~20 s tras arrancar el worker.

## 5. Qué NO está verificado aún
Se probó con un proveedor simulado (códigos 200/401/422/429/5xx y caída de red). **El envío real con Resend no se pudo probar** (la red del entorno de desarrollo bloquea internet): hazlo con la prueba del punto 3.2.4.
