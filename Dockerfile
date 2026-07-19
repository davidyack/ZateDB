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
# the registry resolution has issues. Without them the process still
# starts, in standalone (single-node) mode for the HA deps or with
# telemetry degraded to a no-op provider — see cluster/factory.ts and
# telemetry/otel.ts.
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
