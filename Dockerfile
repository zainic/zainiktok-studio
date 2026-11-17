# Pin exactly the user's requested Node.js version.
# IMPORTANT: Node 20.18.0 is end-of-life; upgrade for long-term public production.
FROM node:20.18.0-bookworm-slim
WORKDIR /app

# better-sqlite3 may need native compilation; ffmpeg and yt-dlp support authorized downloads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv make g++ ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir --disable-pip-version-check yt-dlp
ENV PATH="/opt/ytdlp/bin:${PATH}"

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    SECURE_COOKIES=true
EXPOSE 3000
CMD ["node", "server.js"]
