import { fileURLToPath } from 'node:url';
import { CodexProcessManager, CodexSessionAdapter } from '../../src/runtime/codex/index.js';
import { bindCodeChangeCapture } from '../../src/runtime/code-change-worker.js';

export async function createFixtureCodexWorker({ workspace, persistThreadId, persistCapture }) {
  const manager = await CodexProcessManager.create({ executablePath: process.execPath,
    workspaceRoot: workspace.root,
    appServerArgs: [fileURLToPath(new URL('../fixtures/code-change-app-server.mjs', import.meta.url))],
  });
  const session = new CodexSessionAdapter({ manager, workspaceRoot: workspace.root,
    mode: 'CODE_CHANGE', approvalPolicy: 'never', persistThreadId });
  return bindCodeChangeCapture({ session, workspace, persistCapture,
    close: async () => { try { await session.close(); } finally { await manager.close(); } } });
}
