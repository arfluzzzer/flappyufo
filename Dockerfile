# ── Stage 1: Production dependencies only ────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Needed by some native modules (sharp, pg, etc.) on Alpine
RUN apk add --no-cache libc6-compat

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: Build Next.js ────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package*.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* vars are baked into the client bundle at build time.
# Leave empty → client connects to the same origin via /api/socketio.
# Override with a build arg only if you're splitting socket into its own service.
ARG NEXT_PUBLIC_SOCKET_URL=""
ENV NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL

RUN npm run build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache libc6-compat

ENV NODE_ENV=production

# Production node_modules (no dev deps)
COPY --from=deps    /app/node_modules  ./node_modules

# Next.js compiled output + static assets
COPY --from=builder /app/.next         ./.next
COPY --from=builder /app/public        ./public

# Custom server and Next.js config (read at startup by next())
COPY server.js      .
COPY next.config.ts .
COPY package.json   .

# Railway injects PORT automatically; server.js reads process.env.PORT
EXPOSE 3000

CMD ["node", "server.js"]
