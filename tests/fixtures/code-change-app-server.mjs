// Protocol peer fixture, never an authenticated Codex process. Files are edited
// only in the workspace passed by the real adapter's thread/start request.
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const threadId = `fixture-thread-${process.pid}`;
let workspace;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'initialize') return send({ id, result: { userAgent: 'code-change-fixture' } });
  if (method === 'initialized') return;
  if (method === 'thread/start') {
    workspace = params.cwd;
    return send({ id, result: { thread: { id: threadId, sessionId: threadId } } });
  }
  if (method === 'turn/start') {
    if (params.threadId !== threadId || !workspace) throw new Error('Unbound fixture turn');
    const text = params.input.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const brief = JSON.parse(text.slice(text.indexOf('\n') + 1));
    writeFileSync(path.join(workspace, 'file.txt'), `revision ${brief.iteration}\n`);
    const output = { summary: 'Fixture implementation claim',
      requirementClaims: brief.requirements.items.map(r => ({ requirementId: r.requirementId, claim: 'Implemented in fixture' })),
      findingResponses: brief.unresolvedFindings.map(f => ({ findingId: f.findingId, explanation: 'Submitted changed file' })),
      unverified: ['Real Codex and real ChatGPT behavior'],
    };
    const turnId = `fixture-turn-${process.pid}`;
    send({ id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    const item = { type: 'agentMessage', id: `output-${turnId}`, phase: 'final_answer', text: JSON.stringify(output) };
    setImmediate(() => {
      send({ method: 'item/completed', params: { threadId, turnId, item } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [item], error: null } } });
    });
    return;
  }
  if (method === 'thread/read') return send({ id, result: { thread: { id: threadId, status: { type: 'idle' }, turns: [] } } });
  if (id !== undefined) send({ id, error: { code: -32601, message: `Unsupported fixture method: ${method}` } });
});
