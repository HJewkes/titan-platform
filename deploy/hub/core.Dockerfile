# broker-core image: dependencies baked in so the VPS needs no Node on the host.
FROM node:22-alpine
WORKDIR /app
# The workspace lockfile is pnpm's at the repo root, so the image resolves package.json's ranges itself.
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
CMD ["node", "src/core.mjs"]
