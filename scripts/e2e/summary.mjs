// Summaries use this invocation's observed results and TAP skips, not declared coverage alone.
export function skippedTests(tap) {
  return [...tap.matchAll(/^\s*(?:not )?ok \d+ - (.*?) # SKIP(?: (.*))?$/gmu)]
    .map(([, name, reason]) => ({ name, reason:reason ?? '' }));
}
export function summarizeRun(flows, results, skips, gateFailed = false) {
  const expected = new Map(flows.filter(f => f.execution === 'BLOCKED')
    .map(f => [`${f.id} full continuation`, f.gap]));
  const seen = new Set();
  let unexpectedSkips = 0;
  for (const skip of skips) {
    if (!expected.has(skip.name) || expected.get(skip.name) !== skip.reason || seen.has(skip.name)) unexpectedSkips++;
    else seen.add(skip.name);
  }
  let fullRunnablePassed = 0, initialSpinePassed = 0, failed = 0;
  const failures = [];
  for (const flow of flows) {
    const result = results.get(flow.id);
    const passed = flow.execution === 'RUNNABLE' ? result?.outcome === 'PROFILE_PASS' ||
      (flow.id === 'UF-01A' && result?.outcome === 'PASS')
      : result?.outcome === 'INITIAL_SPINE_PASS' && seen.has(`${flow.id} full continuation`);
    if (!passed) { failed++; failures.push(flow.id); }
    else if (flow.execution === 'RUNNABLE') fullRunnablePassed++;
    else initialSpinePassed++;
  }
  if (gateFailed && failed === 0) { failed++; failures.push('GATE_PROCESS'); }
  return { specComplete:flows.filter(f => f.specWave === 'W1-4 COMPLETE').length,
    fullRunnablePassed, initialSpinePassed,
    continuationBlocked:flows.filter(f => f.execution === 'BLOCKED').length,
    failed, unexpectedSkips, failures,
    verdict:failed || unexpectedSkips ? 'FAIL' : flows.some(f => f.execution === 'BLOCKED') ? 'SPINE_GATE_PASS_WITH_BLOCKED_CONTINUATIONS' : 'FULL_PROFILE_PASS_CONTROLLED_EXTERNAL_BOUNDARIES' };
}
