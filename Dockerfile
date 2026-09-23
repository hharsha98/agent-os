FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# HOST=0.0.0.0 is inside the container so Docker port publishing works.
# Publish the host side on 127.0.0.1 (docker-compose.yml).
ENV NODE_ENV=production \
    PORT=8090 \
    HOST=0.0.0.0 \
    HERMES_AGENT_OS_HOME=/data/hermes-agent-os \
    HERMES_AGENT_OS_ENABLE_EXEC=0 \
    HERMES_AGENT_OS_ENABLE_INSTALL=0 \
    HERMES_AGENT_OS_SCHEDULER=1 \
    HERMES_AGENT_OS_SCHEDULER_POLL_MS=30000

VOLUME ["/data/hermes-agent-os"]
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8090) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
