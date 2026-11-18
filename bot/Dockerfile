FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ffmpeg imagemagick webp ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/session && chown -R node:node /app
USER node

ENV NODE_ENV=production
CMD ["node", "start.js"]
