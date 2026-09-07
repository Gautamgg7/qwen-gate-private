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

# Install system deps for Playwright/Chromium (fallback) + Python (for browser_oxide bindings)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    unzip \
    python3 \
    python3-pip \
    python3-venv \
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

# Install Rust (for building browser_oxide)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# Install CMake (for BoringSSL build)
RUN curl -sSL https://github.com/Kitware/CMake/releases/download/v3.30.5/cmake-3.30.5-linux-x86_64.tar.gz -o /tmp/cmake.tar.gz \
    && tar -xzf /tmp/cmake.tar.gz -C /opt \
    && ln -s /opt/cmake-3.30.5-linux-x86_64/bin/cmake /usr/local/bin/cmake \
    && ln -s /opt/cmake-3.30.5-linux-x86_64/bin/ctest /usr/local/bin/ctest \
    && rm /tmp/cmake.tar.gz

# Install libclang (for bindgen)
RUN apt-get update && apt-get install -y libclang-dev && rm -rf /var/lib/apt/lists/*
ENV LIBCLANG_PATH=/usr/lib/x86_64-linux-gnu

# Install maturin (for building browser_oxide Python bindings)
RUN pip3 install --break-system-packages maturin

# Build browser_oxide (Rust) and Python bindings
RUN git clone --depth 1 https://github.com/yfedoseev/browser_oxide.git /tmp/browser_oxide \
    && cd /tmp/browser_oxide \
    && cargo build --release -p browser_oxide \
    && cp target/release/browser_oxide /usr/local/bin/ \
    && cd crates/browser_oxide_py \
    && maturin develop --release --break-system-packages \
    && cd / \
    && rm -rf /tmp/browser_oxide

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

# Install Playwright Chromium (fallback for login + when browser_oxide is unavailable)
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
EXPOSE 26405
VOLUME [ "/app/.qwen" ]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:26405/v1/models || exit 1

CMD [ "bun", "src/index.tsx" ]
