# msnodesqlv8 (Windows-only ODBC driver, used for local LocalDB dev) is an
# optionalDependency — skipped here with --omit=optional so the Linux build
# never attempts to compile it. Production always runs DB_DRIVER=tedious.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY client ./client
EXPOSE 3000
CMD ["node", "server/server.js"]
