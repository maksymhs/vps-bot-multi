/**
 * Shared Set to track projects currently being built/deployed.
 * This prevents race conditions where the same project
 * is deployed multiple times simultaneously.
 */
export const buildingSet = new Set()
