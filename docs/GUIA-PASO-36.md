# Paso 36 — Seguridad de la cuenta

Tres mejoras. Hay **una migración nueva (0046)**: `npm run db:migrate`.

## 1. Cambiar la contraseña pide el código de dos pasos
Si la persona tiene la verificación en dos pasos activa (el súper admin siempre), «Cambiar contraseña» pide además el código de 6 dígitos de la app. Así una sesión abierta que alguien se lleve no basta para quedarse con la cuenta.
- El código se **consume**: el mismo código no sirve dos veces (igual que al apagar el 2FA).
- Un código o una contraseña actual incorrectos cuentan como intento fallido (a los 5 se bloquea 15 minutos).
- Sin 2FA todo sigue igual (solo la contraseña actual).
- Recuperar la contraseña por correo no cambia: quien la recupera igual necesita el código para entrar.

## 2. Bloqueo hasta aceptar los términos nuevos
Antes, cuando cambiaba la versión de los documentos legales, solo salía un aviso en el panel. Ahora (con `LEGAL_CONSENT=required`, que es lo normal en el servidor):
- Quien no aceptó la versión vigente queda **bloqueado**: las páginas lo mandan a **/terminos-nuevos** y la API responde 403 `terminos_pendientes`.
- Solo puede: aceptar, ver quién es (`/api/me`), salir, y descargar sus datos (`/api/privacy/export`).
- Vale también para el súper admin (la primera vez que entre tendrá que aceptar una vez).
- Quien ya aceptó no nota nada (se recuerda 60 s para no consultar la base en cada petición, así que tras aceptar o tras un cambio de versión puede tardar hasta 1 minuto en notarse en otras pestañas).
- En el modo de pruebas (`LEGAL_CONSENT=optional`, solo en tu PC) nadie se bloquea.
- **Cuando publiques una versión nueva** de los documentos (cambias `LEGAL_VERSION` en `src/lib/legal/docs.ts`), TODOS los usuarios existentes tendrán que aceptar al entrar. Hazlo a propósito.

## 3. Aviso por correo de un inicio de sesión desde un dispositivo nuevo
- «Dispositivo» = navegador + sistema (p. ej. «Chrome en Windows»), sin versiones: actualizar el navegador no cuenta como nuevo. No se guarda el texto completo del navegador, solo esa etiqueta, una huella, la fecha y la última IP.
- La primera vez que alguien entra no se avisa (es su dispositivo habitual). A partir de ahí, un dispositivo nuevo genera un correo: «Nuevo inicio de sesión en tu cuenta» con qué dispositivo, desde qué IP y qué hacer si no fue él.
- Con 2FA el aviso sale **al completar el código**, no con solo la contraseña (así quien solo conozca la contraseña no puede llenar tu bandeja).
- Máximo un aviso por hora por persona. Si el correo falla, el inicio de sesión no se afecta.
- Necesita que el correo esté configurado de verdad (en tu PC solo aparece en `/dev/correos`).
- Se recuerdan hasta 30 dispositivos por persona.

## Aparte: pruebas
`tests/global-setup.ts` ahora borra, antes de cada corrida, los correos de prueba (`@example.test`) de la bandeja de salida. Esos correos se acumulaban hasta el tope de 5000 pendientes y hacían fallar `email.test.ts`: ya no hará falta `limpiar-correos.mjs`.
Se actualizó `tests/account.test.ts` (el súper admin ahora cambia su contraseña con código).

## Límites
- No hay (todavía) lista de «dispositivos y sesiones» ni botón para cerrar una sesión concreta; «cerrar todas las sesiones» ya existía.
- No se usa geolocalización de IP: el aviso muestra la IP, no el país.
- El aviso depende del texto del navegador (User-Agent), que se puede falsear: es una ayuda, no una barrera.
