/**
 * Single source of truth for the server's name and version string, shared by
 * the HELLO handshake reply, the INFO command, and the Prometheus
 * build-info metric — so a version bump lands in one place rather than
 * drifting across three separate hard-coded literals.
 */
export const SERVER_NAME = 'zatedb';
export const SERVER_VERSION = '1.0.0';
