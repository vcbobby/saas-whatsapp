#!/usr/bin/env bash
# Crea (o actualiza) tu usuario súper admin. Pide correo y contraseña (mín. 16 caracteres) sin mostrarla.
. "$(dirname "$0")/_comun.sh"
dc run --rm -it migrate node scripts/create-super-admin.mjs
echo "Después entra a APP_URL/entrar y activa la verificación en dos pasos (obligatoria para el súper admin)."
