FROM ghcr.io/astral-sh/uv:0.8.22 AS uv

# Grok registration requires Chromium, a virtual display and Python 3.13.
FROM node:20-bookworm-slim
COPY --from=uv /uv /uvx /usr/local/bin/
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        fonts-liberation \
        xauth \
        xvfb \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
ENV UV_CACHE_DIR=/opt/uv/cache
RUN uv sync \
      --frozen \
      --no-dev \
      --no-install-project \
      --project /app/src/vendor/xai-registration-engine \
    && /app/src/vendor/xai-registration-engine/.venv/bin/python -c \
      "from DrissionPage import ChromiumOptions; from curl_cffi import requests; print('Grok registration runtime ready')" \
    && rm -rf /opt/uv/cache
RUN mkdir -p /app/logs

ENV NODE_ENV=production

EXPOSE 1455 1456 1458 3100 8085 8086

CMD ["node", "src/core/master.js"]
