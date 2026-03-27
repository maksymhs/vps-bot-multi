/**
 * Shared Set to track projects currently being built/deployed.
 * This prevents race conditions where the same project
 * is deployed multiple times simultaneously.
 */
export const buildingSet = new Set()

/**
 * Tracks projects where pollUntilReady is actively polling /health.
 * buildingSet clears as soon as deployRebuild returns (nearly instant for HTTP rebuilds),
 * but the actual build runs for 30-90s inside the container.
 * pollingSet stays active for the full duration so the conversational handler
 * can queue follow-up changes instead of firing parallel rebuilds.
 */
export const pollingSet = new Set()
