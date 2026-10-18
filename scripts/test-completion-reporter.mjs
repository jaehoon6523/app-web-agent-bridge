import fs from 'node:fs';
import path from 'node:path';
import {tap} from 'node:test/reporters';

// A receipt is written only after the runner stream, including its plan, ends.
// An exit code alone cannot establish that the scheduled tests finished.
export default async function* reporter(source) {
  const result = {completed:false, plan:null, topLevel:0, passed:0, failed:0, skipped:[], todo:[], synthetic:0};
  async function* observe() {
    for await (const event of source) {
      const {type, data} = event;
      if (type === 'test:plan' && data.nesting === 0) result.plan = data.count;
      if (type === 'test:pass' || type === 'test:fail') {
        if (data.nesting === 0) result.topLevel++;
        if (path.resolve(data.name) === path.resolve(process.env.BRIDGE_TEST_FILE ?? data.file ?? '.')) result.synthetic++;
        if (type === 'test:fail') result.failed++;
        else if (data.skip) result.skipped.push(data.name);
        else if (data.todo) result.todo.push(data.name);
        else if (data.details?.type !== 'suite') result.passed++;
      }
      yield event;
    }
  }
  yield* tap(observe());
  result.completed = result.plan > 0 && result.plan === result.topLevel && result.synthetic === 0;
  if (process.env.BRIDGE_TEST_RECEIPT_FD !== undefined) {
    const descriptor = Number(process.env.BRIDGE_TEST_RECEIPT_FD);
    if (!Number.isSafeInteger(descriptor) || descriptor < 3) throw Error('INVALID_COMPLETION_DESCRIPTOR');
    // The parent owns this file object until the child closes. Its directory
    // name may disappear during a long test; do not reopen it at completion.
    fs.writeFileSync(descriptor, JSON.stringify(result)+'\n');
  } else if (process.env.BRIDGE_TEST_RECEIPT) {
    fs.writeFileSync(process.env.BRIDGE_TEST_RECEIPT, JSON.stringify(result)+'\n', {flag:'wx'});
  }
}
