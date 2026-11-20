import { main } from '../../../src/server.js';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '../../../src/config.js';
import { SqliteStore } from '../../../src/persistence/sqlite-store.js';
import { RunService } from '../../../src/orchestration/run-service.js';
import { createDiscussionRunPolicy } from '../../../src/domain/run-policy.js';

const config = loadConfig();
fs.mkdirSync(path.dirname(config.persistence.databasePath), {recursive:true});
const store = new SqliteStore(config.persistence.databasePath);
try {
  const runs = new RunService({store});
  const history = runs.createRun({runId:'receipt-history',objective:'Receipt navigation fixture',policy:createDiscussionRunPolicy()});
  runs.stop({runId:history.runId,expectedVersion:history.version});
} finally { store.close(); }

await main(config, {onDiagnostic(event) {
  if (event.type === 'command.request.correlated') console.log('[fixture:command] ' + JSON.stringify({
    httpRequestId:event.requestId, commandRequestId:event.commandRequestId,
  }));
}});
