// Ambient fallback declarations for the optionalDependencies imported
// dynamically in otel.ts. npm does not reliably install
// optionalDependencies in every environment (that's the point of them
// being optional — see the runtime no-op fallback in otel.ts), so
// typecheck/build must not depend on their type declarations being
// present. When a package IS actually installed, TypeScript's real module
// resolution takes precedence over these shorthand ambient declarations;
// this file only fills the gap when it isn't.
declare module '@opentelemetry/sdk-node';
declare module '@opentelemetry/sdk-trace-node';
declare module '@opentelemetry/sdk-metrics';
declare module '@opentelemetry/resources';
declare module '@opentelemetry/semantic-conventions';
declare module '@opentelemetry/exporter-trace-otlp-http';
declare module '@opentelemetry/exporter-metrics-otlp-http';
declare module '@azure/monitor-opentelemetry-exporter';
