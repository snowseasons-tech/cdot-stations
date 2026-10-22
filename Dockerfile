FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATUS_FILE=/var/lib/cdot/status.json \
    SUBSCRIPTIONS_FILE=/var/lib/cdot/subscriptions.json \
    POSITIONS_FILE=/var/lib/cdot/positions.json

WORKDIR /app
# The one runtime dependency (web-push) is installed first, from the lockfile, so this layer is reused until
# package.json or package-lock.json change. Install scripts are disabled: none of the packages need them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY *.js ./
COPY adapters ./adapters
COPY public ./public
COPY data/stations.json data/inspections.json data/inspection-locations.json ./data/
COPY scripts ./scripts

# Status, history, push subscriptions and saved station positions live on this volume; mount it to keep them across deploys.
RUN mkdir -p /var/lib/cdot && chown node:node /var/lib/cdot
VOLUME /var/lib/cdot

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/api/stations >/dev/null || exit 1
CMD ["node", "server.js"]
