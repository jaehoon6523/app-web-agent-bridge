// Explicit browser gate. Individual flow entry points live in tests/e2e/flows.
import { flows, registerFlow } from './flow-runner.mjs';
for (const flow of flows) if (flow.id !== 'UF-01A') registerFlow(flow.id);
