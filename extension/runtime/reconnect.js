export function createReconnectController({ connect, connected, onError, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let attempts = 0;
  let blocked = false;
  let pairingAttempts = 0;
  const controller = {
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    accepted() {
      controller.requested();
    },
    requested() {
      blocked = false;
      attempts = 0;
      pairingAttempts = 0;
      controller.cancel();
    },
    schedulePairing() {
      if (timer !== null || connected() || pairingAttempts >= 10) return;
      blocked = false;
      pairingAttempts++;
      timer = setTimer(async () => {
        timer = null;
        try { await connect(); }
        catch (error) { onError(error); controller.schedulePairing(); }
      }, 30_000);
    },
    schedule(closeCode) {
      // Authentication rejection and occupied controllers require user action.
      if (closeCode === 4403 || closeCode === 4409) {
        blocked = true; controller.cancel(); return;
      }
      if (blocked || timer !== null || connected()) return;
      const delay = Math.min(30_000, 2_000 * (2 ** Math.min(attempts++, 4)));
      timer = setTimer(async () => {
        timer = null;
        try { await connect(); }
        catch (error) {
          if (blocked) return;
          onError(error);
          controller.schedule(0);
        }
      }, delay);
    },
  };
  return controller;
}
