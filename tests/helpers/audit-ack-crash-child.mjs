import path from 'node:path';
import {publishCrashCheckpoint} from './audit-crash-checkpoint.js';
import { setupAudit, assertionsFor } from './audit-fixtures.js';
import { ArtifactStore } from '../../src/evidence/artifact-store.js';
import { CodeChangeService } from '../../src/orchestration/code-change-service.js';

function boundary(value) {
  publishCrashCheckpoint('boundary', value);
  // Keep the exact synchronous persistence boundary open until the parent kills us.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (process.argv[2] === 'recover') {
  const metadata = JSON.parse(process.argv[3]), update = CodeChangeService.prototype.update;
  publishCrashCheckpoint('ready', metadata);
  CodeChangeService.prototype.update = function(runId, changes) {
    const result = update.call(this, runId, changes);
    if (changes.requests?.some(item => item.status === 'PROCESSED')) boundary({ runId, snapshot:result });
    return result;
  };
  new CodeChangeService({ filename:metadata.filename, project:metadata.project,
    artifactStore:new ArtifactStore(path.join(metadata.directory, 'artifacts')),
    webSession:{ submitTurn() { throw new Error('Recovery must not send'); } }, codex:{},
  });
  throw new Error('Recovery crash boundary was not reached');
}

const sensitive = process.argv.includes('--sensitive-response');
const f = setupAudit({ after() {} }, { reviewVerdicts:['SATISFIED'],
  reviewBody:() => process.argv.includes('--fenced-response') ? '```text\npassword=\n```' : 'Original review reasoning.',
  ...(sensitive ? {review:data => {
    const packet = assertionsFor(data.context, 'UNDETERMINED');
    packet.assessments[0].missingInformation = 'password=crash-example';
    return packet;
  }} : {}),
});
const submit = f.options.webSession.submitTurn;
f.options.webSession.submitTurn = async function(input) {
  const handle = await submit.call(this, input);
  return { ...handle, completion:handle.completion.then(response => ({ ...response,
    rawText:`${response.body}\n<controller_packet>\n${response.packetText}\n</controller_packet>` })) };
};
publishCrashCheckpoint('ready', {directory:f.directory, filename:f.options.filename, project:f.options.project});
const update = f.service.update.bind(f.service);
f.service.update = (runId, changes) => {
  const saved = update(runId, changes);
  if (changes.webDeliveryReceipts?.some(item => item.state === 'ACKNOWLEDGED')) {
    boundary({ runId, snapshot:saved, acknowledgements:f.acknowledgements });
  }
  return saved;
};
await f.run();
throw new Error('ACK crash boundary was not reached');
