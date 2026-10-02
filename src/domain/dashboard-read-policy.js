// Bound /api/state snapshot runtime waiting below the HTTP response budget.
// This reserve is policy, not a guarantee of end-to-end response latency.
export const MIN_CONFIGURED_DASHBOARD_RUNTIME_READ_TIMEOUT_MS = 100;
export const DEFAULT_DASHBOARD_RUNTIME_READ_TIMEOUT_MS = 2000;
export const DASHBOARD_READ_RESPONSE_BUDGET_MS = 5000;
// Reserve response time for projection, serialization and delivery; this is a policy budget.
export const DASHBOARD_READ_RESPONSE_RESERVE_MS = 1000;
export const MAX_DASHBOARD_RUNTIME_READ_TIMEOUT_MS = DASHBOARD_READ_RESPONSE_BUDGET_MS - DASHBOARD_READ_RESPONSE_RESERVE_MS;

export function validateDashboardRuntimeReadTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DASHBOARD_RUNTIME_READ_TIMEOUT_MS) {
    throw new RangeError(`dashboard runtime read timeout must be an integer between 1 and ${MAX_DASHBOARD_RUNTIME_READ_TIMEOUT_MS}.`);
  }
  return value;
}
