// External JSONL peer, not a real authenticated Qwen/Codex service.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const output = process.argv[2];
readline.createInterface({ input:process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type !== 'turn') return;
  const brief = JSON.parse(message.text.slice(message.text.indexOf('\n') + 1));
  fs.writeFileSync(path.join(message.workspaceRoot, 'clock.txt'), brief.iteration === 1 ? 'Controlled worker candidate: hours minutes seconds\n' : 'Controlled worker candidate: hours minutes seconds revision 2\n');
  fs.writeFileSync(output, JSON.stringify({ pid:process.pid, turnId:message.turnId, sessionId:message.sessionId, workspaceRoot:message.workspaceRoot, requirementIds:brief.requirements.items.map(item => item.requirementId) }));
  const historyPath = path.join(path.dirname(output), 'worker-history.json');
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath)) : [];
  history.push({ ...message, brief }); fs.writeFileSync(historyPath, JSON.stringify(history));
  const report = { summary:'Controlled executable implementation', requirementClaims:brief.requirements.items.map(item => ({ requirementId:item.requirementId, claim:'Controlled candidate written' })), findingResponses:brief.unresolvedFindings.map(f=>({findingId:f.findingId,explanation:'Controlled revision 2 submitted'})), unverified:['Actual model implementation and independent review'] };
  process.stdout.write(JSON.stringify({ type:'completion', turnId:message.turnId, sessionId:message.sessionId, status:'completed', text:JSON.stringify(report) })+'\n');
});
