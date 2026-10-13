// Explicit native boundaries required by the full verification gate.
export const nativeExtensionSteps = Object.freeze([
  'injection', 'diagnostic-export', 'window-resize', 'pending-reinjection',
  'worker-restart', 'navigation', 'extension-reload',
]);

export function nativeExtensionComplete(receipt) {
  return receipt?.nativeExtension === true && receipt.status === 'PASS' && receipt.completed === true
    && Array.isArray(receipt.steps) && receipt.steps.length === nativeExtensionSteps.length
    && new Set(receipt.steps.map(step => step.id)).size === nativeExtensionSteps.length
    && nativeExtensionSteps.every(id => receipt.steps.some(step => step.id === id && step.pass === true));
}
