FROM node:20-bullseye-slim AS node
FROM mongo:7.0-jammy
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENTRYPOINT []
CMD ["bash", "scripts/ai-phase2g-railway.sh"]
