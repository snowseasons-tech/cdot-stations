FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATUS_FILE=/var/lib/cdot/status.json

WORKDIR /app
COPY package.json *.js ./
COPY adapters ./adapters
COPY public ./public
COPY data/stations.json data/inspections.json data/inspection-locations.json ./data/
COPY scripts ./scripts

# Status and history live on this volume; mount it to keep them across deploys.
RUN mkdir -p /var/lib/cdot && chown node:node /var/lib/cdot
VOLUME /var/lib/cdot

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/api/stations >/dev/null || exit 1
CMD ["node", "server.js"]
