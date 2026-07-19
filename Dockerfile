FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force
# Optional OpenTelemetry exporter and Azure HA (Cosmos DB / Service Bus)
# deps are best-effort — install them but don't fail the image build if
# the registry resolution has issues. Their absence at runtime is handled
# very differently depending on whether HA is actually configured:
#   - No COSMOS_*/SERVICE_BUS_* env vars set: the process runs standalone
#     (single-node, in-memory-only) and never needs these packages at all.
#   - COSMOS_*/SERVICE_BUS_* env vars ARE set but the packages failed to
#     install here: the process fails fast at startup (see index.ts's
#     withTimeout + createClusterCoordinator's dynamic import) rather than
#     silently downgrading to standalone — an operator who configured HA
#     needs to know it isn't actually running, not have it look healthy
#     while quietly losing the durability/sync guarantee.
# Telemetry alone degrades to a no-op provider either way — see telemetry/otel.ts.
RUN npm install --omit=dev \
    @azure/cosmos \
    @azure/identity \
    @azure/monitor-opentelemetry-exporter \
    @azure/service-bus \
    @opentelemetry/exporter-metrics-otlp-http \
    @opentelemetry/exporter-trace-otlp-http \
    @opentelemetry/resources \
    @opentelemetry/sdk-metrics \
    @opentelemetry/sdk-node \
    @opentelemetry/sdk-trace-node \
    @opentelemetry/semantic-conventions \
    || echo "optional telemetry/HA exporters not installed; continuing in standalone/no-export mode"
COPY --from=build /app/dist ./dist

EXPOSE 6379 8081 8082
USER node
CMD ["node", "dist/index.js"]
