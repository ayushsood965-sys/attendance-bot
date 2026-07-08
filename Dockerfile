FROM node:20-slim

# Install Chromium + Xvfb (required by puppeteer-real-browser on Linux)
RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libegl1 \
    libgl1 \
    libglx-mesa0 \
    libgles2 \
    libxshmfence1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:99 \
    TZ=Asia/Kolkata \
    NODE_ENV=production \
    HOME=/app \
    XDG_CONFIG_HOME=/app/.config \
    XDG_CACHE_HOME=/app/.cache

# Create app directory
WORKDIR /app

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Create directories for logs, screenshots, and X11 socket
RUN mkdir -p logs screenshots /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Start the application
CMD ["node", "src/index.js", "--run-now", "--dry-run"]
