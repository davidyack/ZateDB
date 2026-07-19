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
# Optional OpenTelemetry exporter deps are best-effort — install them but
# don't fail the image build if the registry resolution has issues.
RUN npm install --omit=dev \
    @azure/monitor-opentelemetry-exporter \
    @opentelemetry/exporter-metrics-otlp-http \
    @opentelemetry/exporter-trace-otlp-http \
    @opentelemetry/resources \
    @opentelemetry/sdk-metrics \
    @opentelemetry/sdk-node \
    @opentelemetry/sdk-trace-node \
    @opentelemetry/semantic-conventions \
    || echo "optional telemetry exporters not installed; continuing without export"
COPY --from=build /app/dist ./dist

EXPOSE 6379 8081 8082
USER node
CMD ["node", "dist/index.js"]
