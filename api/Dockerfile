FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a code change does not re-resolve the tree.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src

# Accounts live here. Mount a volume or the file goes with the container.
ENV DATA_DIR=/data
VOLUME /data

ENV PORT=8080
EXPOSE 8080

# Do not run as root.
RUN addgroup -S gf && adduser -S gf -G gf && mkdir -p /data && chown gf:gf /data
USER gf

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "src/server.js"]
