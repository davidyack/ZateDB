# Pinned to a specific Node 22 LTS patch rather than the floating `node:22-slim`
# tag, so a rebuild can't silently pull a different base. Node 22+ is required:
# the @azure/* optionalDependencies' transitive core packages declare
# `engines.node >= 22`, and npm silently SKIPS optional deps that fail the
# engine check — on a Node 20 base the runtime `npm ci` quietly omitted the
# whole @azure tree, so HA-configured containers crashed at startup with
# "Cannot find package '@azure/cosmos'" (the smoke check below now catches
# this at build time). For a fully reproducible, tamper-evident build, pin by
# digest instead — override at build time with
# `--build-arg NODE_IMAGE=node:22.23.1-slim@sha256:<digest>` (resolve the
# current digest with `docker buildx imagetools inspect node:22.23.1-slim`).
ARG NODE_IMAGE=node:22.23.1-slim

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
# deps — @azure/cosmos, @azure/identity, @azure/service-bus). "Optional" is
# npm's installability escape hatch for local/dev installs, not a statement
# that the published image works without them — a missing package at runtime
# means either a no-op telemetry provider (OTel exporters — see
# telemetry/otel.ts) or, when COSMOS_*/SERVICE_BUS_* env vars are set, a
# fail-fast startup crash (see index.ts's withTimeout +
# createClusterCoordinator's dynamic import) rather than a silent downgrade
# to standalone — an operator who configured HA needs to know it isn't
# actually running, not have it look healthy while quietly losing the
# durability/sync guarantee.
RUN npm ci --omit=dev && npm cache clean --force
# npm treats an optional dep that fails its engine/platform check as
# skippable and installs WITHOUT it, warning at most — which is how a Node
# 20 base image shipped with no @azure packages at all. Import every
# declared optionalDependency here so that failure mode breaks the build
# loudly instead of surfacing as a startup crash (or silent no-op
# telemetry) in production.
RUN node --input-type=module -e "\
  const { default: pkg } = await import('./package.json', { with: { type: 'json' } }); \
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) await import(dep); \
  "
COPY --from=build /app/dist ./dist
EXPOSE 6379 8081 8082
USER node
CMD ["node", "dist/index.js"]
