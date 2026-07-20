# Pinned to a specific Node 20 LTS patch rather than the floating `node:20-slim`
# tag, so a rebuild can't silently pull a different base. For a fully
# reproducible, tamper-evident build, pin by digest instead — override at build
# time with `--build-arg NODE_IMAGE=node:20.18.1-slim@sha256:<digest>` (resolve
# the current digest with `docker buildx imagetools inspect node:20.18.1-slim`).
ARG NODE_IMAGE=node:20.18.1-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Deterministic install straight from the lockfile. --omit=dev drops build/test
# deps but keeps optionalDependencies (the OTel exporters and the Azure HA
# deps — @azure/cosmos, @azure/identity, @azure/service-bus), which degrade
# gracefully if a package fails to resolve here. That degradation means very
# different things depending on which package it is:
#   - OTel exporters: telemetry degrades to a no-op provider — see telemetry/otel.ts.
#   - Azure HA deps: only matters if COSMOS_*/SERVICE_BUS_* env vars are also
#     set. If neither is set, the process runs standalone (single-node,
#     in-memory-only) and never needs these packages at all. If they ARE set
#     but the packages didn't install, the process fails fast at startup (see
#     index.ts's withTimeout + createClusterCoordinator's dynamic import)
#     rather than silently downgrading to standalone — an operator who
#     configured HA needs to know it isn't actually running, not have it
#     look healthy while quietly losing the durability/sync guarantee.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 6379 8081 8082
USER node
CMD ["node", "dist/index.js"]
