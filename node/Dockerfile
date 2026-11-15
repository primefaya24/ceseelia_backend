# The API's runtime image (S.15). Build `dist/` first (npm run build); it's copied as is.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /usr/src/app

# Exactly the locked production dependencies, no dev tools, no npm cache left behind.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY dist ./dist

# Never run as root: the node image ships an unprivileged `node` user.
USER node

EXPOSE 3100

# 9.3: Docker marks the container unhealthy if /healthz stops answering (busybox wget is in alpine).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3100/healthz || exit 1

# node as PID 1 receives SIGTERM directly, so the graceful shutdown in index.ts runs.
CMD ["node", "dist/index.js"]
