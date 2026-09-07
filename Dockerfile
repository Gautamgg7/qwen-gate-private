# ── Build stage ─────────────────────────────────────────────────────
FROM oven/bun:debian AS build
WORKDIR /app
COPY package.json bun.lock* package-lock.json* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install
COPY . .
RUN bun run build 2>/dev/null || true

# ── Production stage ────────────────────────────────────────────────
FROM debian:bookworm-slim AS production
WORKDIR /app

# Install system deps for Playwright/Chromium (fallback) + Lightpanda (preferred)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    unzip \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libxshmfence1 \
    libasound2 \
    libatspi2.0-0 \
    libglib2.0-0 \
    libfreetype6 \
    libfontconfig1 \
    libdbus-1-3 \
    fonts-noto-cjk \
    fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

# Install Lightpanda browser (lightweight, 170MB, used as preferred backend)
RUN curl -L -o /usr/local/bin/lightpanda \
      https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux \
    && chmod a+x /usr/local/bin/lightpanda \
    && /usr/local/bin/lightpanda version

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL=/root/.bun
ENV PATH=$BUN_INSTALL/bin:$PATH

# Copy built artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/config.json ./config.json
COPY --from=build /app/bin ./bin

# Install Playwright Chromium (fallback for login/WAF)
RUN bunx playwright install --with-deps chromium 2>/dev/null || \
    npx playwright install --with-deps chromium 2>/dev/null || true

# Non-root user for security
RUN groupadd -g 1001 qwen && \
    useradd -u 1001 -g qwen -m qwen && \
    mkdir -p /app/.qwen /app/logs && \
    chown -R qwen:qwen /app
USER qwen

ENV QWEN_GATE_PORT=26405
ENV NODE_ENV=production
ENV LIGHTPANDA_BINARY=/usr/local/bin/lightpanda
ENV LIGHTPANDA_PORT=9222
EXPOSE 26405
VOLUME [ "/app/.qwen" ]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:26405/v1/models || exit 1

CMD [ "bun", "src/index.tsx" ]
