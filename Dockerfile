# Imagen del ticket-scanner para la Raspberry Pi (arm64).
# Se construye EN la Pi con "git push pi main" (ver deploy/).
# better-sqlite3 es nativo: se compila en la etapa 1, que trae python3/make/g++.

# ---------- 1. dependencias (con herramientas de compilación) ----------
FROM docker.io/library/node:24-bookworm AS dependencias
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- 2. imagen final, ligera ----------
FROM docker.io/library/node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencias /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
# Los datos (bases y fotos) viven en el volumen /data; el .env y la clave del
# banco llegan como Secrets de Kubernetes. Nada de eso va en la imagen.
USER node
EXPOSE 3000
CMD ["node", "src/app.js"]
