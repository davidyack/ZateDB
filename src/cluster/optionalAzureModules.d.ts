// Ambient fallback declarations for the optionalDependencies imported
// dynamically in cosmosDurableStore.ts / serviceBusTransport.ts. npm does
// not reliably install optionalDependencies in every environment — running
// standalone (single-node, no durable store/replication configured) must
// keep working and typechecking without these packages installed. When a
// package IS actually installed, TypeScript's real module resolution takes
// precedence over these shorthand ambient declarations; this file only
// fills the gap when it isn't. See telemetry/optionalOtelModules.d.ts for
// the same pattern applied to the OTel exporter packages.
declare module '@azure/cosmos';
declare module '@azure/service-bus';
declare module '@azure/identity';
