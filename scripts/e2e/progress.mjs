// Progress is completed profiles, not elapsed time or a coverage verdict.
export function createProgress(ids, write) {
  const allowed = new Set(ids), done = new Set();
  let pending = '', current = 'starting';
  const print = message => write(`[E2E ${Math.floor(done.size / ids.length * 100)}%] ${done.size}/${ids.length} ${message}\n`);
  function complete(id, status) {
    if (!allowed.has(id) || done.has(id)) return;
    done.add(id);
    current = done.size === ids.length ? 'profiles complete; waiting for summary/process exit' : `${id} finished; waiting for next profile`;
    print(`${id} ${status}${done.size === ids.length ? ' | final summary / process exit pending' : ''}`);
  }
  function line(value) {
    const started = /^# Subtest: (UF-\d+(?:[ABC])?)\b/u.exec(value);
    if (started && allowed.has(started[1])) { current = `${started[1]} running`; print(current); }
    const ended = /^(not ok|ok) \d+ - (UF-\d+(?:[ABC])?)\b/u.exec(value);
    if (ended) complete(ended[2], ended[1] === 'ok' ? 'PASS' : 'FAIL');
  }
  print('starting');
  return {
    complete,
    status: () => current,
    consume(chunk) {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop();
      for (const value of lines) line(value);
    },
    flush() { if (pending) line(pending); pending = ''; },
  };
}
