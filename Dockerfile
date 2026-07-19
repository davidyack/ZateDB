FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Deterministic install straight from the lockfile. --omit=dev drops build/test
# deps but keeps optionalDependencies (the OTel exporters), which degrade to a
# no-op provider at runtime if a beta exporter fails to resolve — no separate
# best-effort install step needed.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 6379 8081 8082
USER node
CMD ["node", "dist/index.js"]
