# broker-core image: dependencies baked in so the VPS needs no Node on the host.
# Built from the repo root so the root pnpm-lock.yaml pins every dependency, matrix-bus included.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @titan-design/hub-deploy... --filter titan-platform
RUN pnpm --filter @titan-design/matrix-bus build \
 && pnpm --filter @titan-design/hub-deploy deploy --prod /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/src ./src
CMD ["node", "src/core.mjs"]
