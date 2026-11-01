// Explicit browser gate. Individual flow entry points live in tests/e2e/flows.
import { flows, registerFlow } from './flow-runner.mjs';
import { recordProcess } from './diagnostics.mjs';
recordProcess('wave-test-worker',process.pid,process.ppid);
const selected = process.env.E2E_FLOW_IDS?.split(',');
for (const flow of flows) if (flow.id !== 'UF-01A' && (!selected || selected.includes(flow.id))) registerFlow(flow.id);
