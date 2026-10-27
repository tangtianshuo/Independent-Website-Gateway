FROM node:22-slim

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm ci --no-audit --no-fund \
    && npm run build --workspace @gateway/worker \
    && npm run build --workspace @gateway/control

ARG SOURCE_COMMIT
ARG RELEASE_VERSION
LABEL org.opencontainers.image.revision="$SOURCE_COMMIT" \
      org.opencontainers.image.version="$RELEASE_VERSION"

ENV NODE_ENV=production

EXPOSE 18183

CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/control", "-p", "18183", "-H", "0.0.0.0"]
