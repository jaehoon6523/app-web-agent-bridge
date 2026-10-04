// Explicit browser gate. Individual flow entry points live in tests/e2e/flows.
import { flows, registerFlow } from './flow-runner.mjs';
const selected = process.env.E2E_FLOW_IDS?.split(',');
for (const flow of flows) if (flow.id !== 'UF-01A' && (!selected || selected.includes(flow.id))) registerFlow(flow.id);
