export function createReconnectController({ connect, connected, onError, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let attempts = 0;
  const controller = {
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    accepted() {
      attempts = 0;
      controller.cancel();
    },
    schedule(closeCode) {
      // Wrong credentials require user configuration; reconnect cannot repair them.
      if (closeCode === 4403 || timer !== null || connected()) return;
      const delay = Math.min(30_000, 2_000 * (2 ** Math.min(attempts++, 4)));
      timer = setTimer(async () => {
        timer = null;
        try { await connect(); }
        catch (error) {
          onError(error);
          controller.schedule(0);
        }
      }, delay);
    },
  };
  return controller;
}
