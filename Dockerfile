# syntax=docker/dockerfile:1.7
# NEXOFIS — Multi-stage Production Container (Node.js 22)
# Licença: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    NEXOFIS_DB_DRIVER=sqlite \
    DISABLE_HMR=true

# Usuário não-root para isolamento de segurança em produção
RUN addgroup -S nexofis && adduser -S nexofis -G nexofis \
    && mkdir -p /app/data \
    && chown -R nexofis:nexofis /app

COPY --from=deps --chown=nexofis:nexofis /app/node_modules ./node_modules
COPY --from=builder --chown=nexofis:nexofis /app/dist ./dist
COPY --chown=nexofis:nexofis package.json tsconfig.json server.ts LICENSE README.md ./
COPY --chown=nexofis:nexofis src ./src
COPY --chown=nexofis:nexofis db ./db
COPY --chown=nexofis:nexofis scripts ./scripts

USER nexofis

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npx", "tsx", "server.ts"]
