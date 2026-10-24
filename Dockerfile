# Imagen de la aplicación (la misma sirve para la web y para el worker).
# Construir:  docker compose -f docker-compose.prod.yml build
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_APP_NAME
ARG NEXT_PUBLIC_APP_DOMAIN
ARG NEXT_PUBLIC_SUPPORT_EMAIL
ARG NEXT_PUBLIC_LEGAL_NAME
ARG NEXT_PUBLIC_LEGAL_ADDRESS
ARG NEXT_PUBLIC_LEGAL_COUNTRY
ARG NEXT_PUBLIC_LEGAL_REVIEWED
# El build no necesita base de datos ni claves (probado): todo se lee al arrancar.
RUN npm run build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /models && chown node:node /models
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
