FROM node:24.20.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node assets ./assets
COPY --chown=node:node gitlab-catalog ./gitlab-catalog
COPY docker-entrypoint.sh /usr/local/bin/peerivo-entrypoint

RUN chmod +x /usr/local/bin/peerivo-entrypoint \
    && mkdir -p /data \
    && chown node:node /data

ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/peerivo-entrypoint"]
CMD ["node", "src/server.mjs"]
