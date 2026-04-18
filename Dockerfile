FROM oven/bun:1.2-alpine AS base
WORKDIR /app

# System deps + python-pptx globally (venv can't be used — skills dir is a :ro volume mount)
RUN apk add --no-cache \
    unzip \
    python3 \
    py3-pip \
    fontconfig \
    ttf-dejavu \
    ttf-liberation && \
    fc-cache -fv && \
    pip3 install --break-system-packages --no-cache-dir python-pptx

# ── Bun server deps ───────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# ── Runner ─────────────────────────────────────────────────────────────────────
FROM base AS runner
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY skills ./skills

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]
