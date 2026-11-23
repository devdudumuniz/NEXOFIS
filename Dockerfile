# syntax=docker/dockerfile:1.7
# NEXOFIS — Multi-stage Production Container (Node.js 22 + pnpm workspace)
# Licença: GNU AGPL-3.0-only (Eduardo Muniz — DM Technology)

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY app/api/package.json ./app/api/package.json
COPY app/backend/package.json ./app/backend/package.json
COPY app/frontend/package.json ./app/frontend/package.json
COPY app/shared/package.json ./app/shared/package.json
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    NEXOFIS_DB_DRIVER=sqlite \
    NEXOFIS_SQLITE_PATH=/app/data/nexofis.db \
    DISABLE_HMR=true

# Usuário não-root para isolamento de segurança em produção
RUN addgroup -S nexofis && adduser -S nexofis -G nexofis \
    && mkdir -p /app/data/objects \
    && chown -R nexofis:nexofis /app

COPY --from=deps --chown=nexofis:nexofis /app/node_modules ./node_modules
COPY --from=builder --chown=nexofis:nexofis /app/dist ./dist
COPY --chown=nexofis:nexofis public ./public
COPY --chown=nexofis:nexofis package.json pnpm-workspace.yaml .npmrc tsconfig.json server.ts LICENSE README.md ./
COPY --chown=nexofis:nexofis app ./app
COPY --chown=nexofis:nexofis scripts ./scripts

USER nexofis

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => r.json()).then(d => process.exit(d && d.status === 'ok' ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npx", "tsx", "app/api/src/server.ts"]
