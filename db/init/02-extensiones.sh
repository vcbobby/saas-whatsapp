#!/usr/bin/env bash
# Extensiones que necesitan superusuario. Solo corre al crear la base por primera vez.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS vector"
