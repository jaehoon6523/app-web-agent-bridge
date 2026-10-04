import { performance } from 'node:perf_hooks';

/**
 * @param {Array<[string, () => any]>} steps
 * @param {(type: string, detail: any) => void} [emit]
 */
// No canonical events or provider payloads. A diagnostic sink cannot affect close.
export async function closeSteps(steps, emit = (_type, _detail) => {}) {
  const errors = [];
  const report = (type, detail) => { try { emit(type, detail); } catch {} };
  for (const [stage, close] of steps) {
    const started = performance.now();
    report('shutdown.stage.start', {stage});
    try {
      await close();
      report('shutdown.stage.done', {stage,elapsedMs:performance.now()-started});
    } catch (cause) {
      errors.push(new Error(`Shutdown failed at ${stage}`, {cause}));
      const label = cause?.code ?? cause?.name;
      report('shutdown.stage.error', {stage,elapsedMs:performance.now()-started,
        errorCode:typeof label === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(label) ? label : 'ERROR'});
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(e => e.message).join('; '));
}
