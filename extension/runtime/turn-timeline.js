(function registerTurnTimeline(root) {
  const windowMs = 10_000;
  const maxEvents = 2048;
  // Reserve space for the signal, frozen response and final snapshots even after a burst.
  const maxChangeCharacters = 1_000_000;
  const maxSnapshotCharacters = 750_000;

  function create({ read, onFinish }) {
    const events = [], snapshots = [];
    const times = () => ({ monotonicMs: performance.now(), capturedAt: Date.now() });
    const emit = (type, data = {}) => events.push({ type, ...times(), ...data });
    let previous, identity, timer, deadline, stopReason, signalSeen = false, frozen = false;
    let bodySeen = false;
    const hashes = [];
    let beginSeen = false, endPosition = null, changeCharacters = 0, omittedSnapshots = 0;
    let observer;
    const pageExit = () => finish("DOCUMENT_EXIT");
    function finish(reason) {
      if (stopReason) return;
      stopReason = reason;
      observer?.disconnect();
      clearTimeout(timer);
      window.removeEventListener("pagehide", pageExit);
      if (!identity) return;
      emit("OBSERVATION_END", { reason });
      void Promise.all(hashes).then(() => onFinish({ identity:JSON.parse(identity), events, snapshots, windowMs, omittedSnapshots,
        endPosition: endPosition ?? (reason === "WINDOW_ELAPSED" ? "END_NOT_OBSERVED_WITHIN_WINDOW" : "END_NOT_OBSERVABLE"),
      })).catch(() => {});
    }

    function snapshot(type, value) {
      const html = value.element.outerHTML;
      const raw = value.element.textContent ?? "";
      const size = html.length + raw.length + value.text.length;
      if (size > maxSnapshotCharacters || (type === "POST_SIGNAL_CHANGE"
        && (snapshots.length >= 64 || changeCharacters + size > maxChangeCharacters))) {
        omittedSnapshots++;
        return;
      }
      if (type === "POST_SIGNAL_CHANGE") changeCharacters += size;
      snapshots.push({ type, ...times(), html, raw, extracted:value.text,
        completionAttribute:value.completionAttribute, completionSignal:value.completionSignal,
        stopVisible:value.stopVisible, collectionState:frozen ? "FROZEN" : "OBSERVING" });
    }

    function sample() {
      if (stopReason) return;
      try {
        if (deadline !== undefined && performance.now() >= deadline) {
          const final = read();
          if (final?.stopReason) return finish(final.stopReason);
          if (!final || identity !== JSON.stringify(final.identity)) return finish("TARGET_NOT_OBSERVABLE");
          snapshot("OBSERVATION_END", final);
          // A change first seen at the deadline cannot be placed inside the window.
          return finish(final.raw === previous.raw && final.text === previous.text ? "WINDOW_ELAPSED" : "DEADLINE_SAMPLE_CHANGED");
        }
        if (events.length >= maxEvents) return finish("EVENT_LIMIT");
        const current = read();
        if (current?.stopReason) return finish(current.stopReason);
        if (!current) {
          if (identity) finish("TARGET_NOT_OBSERVABLE");
          return;
        }
        if (!identity) {
          identity = JSON.stringify(current.identity);
          emit("ASSISTANT_FIRST_OBSERVED");
        } else if (identity !== JSON.stringify(current.identity)) return finish("TARGET_ID_CHANGED");

        const changed = !previous || previous.text !== current.text || previous.raw !== current.raw;
        const beginCount = (current.raw.match(/CONTROLLER_PACKET_BEGIN|^답변시작\r?$/gmu) ?? []).length;
        const endCount = (current.raw.match(/CONTROLLER_PACKET_END|^답변끝\r?$/gmu) ?? []).length;
        if (changed) {
          if (current.raw && !bodySeen) {
            bodySeen = true;
            emit("BODY_FIRST_OBSERVED");
          }
          const bytes = new TextEncoder().encode(current.raw);
          const event = { type:"BODY_CHANGED", ...times(), utf8Bytes:bytes.length, beginCount, endCount };
          events.push(event);
          hashes.push(crypto.subtle.digest("SHA-256", bytes).then(digest => {
            event.sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
          }, () => { event.hashUnavailable = true; }));
          if (beginCount && !beginSeen) {
            beginSeen = true;
            emit("BEGIN_FIRST_OBSERVED");
          }
        }
        if (previous?.completionAttribute !== current.completionAttribute) {
          emit("COMPLETION_ATTRIBUTE", { value:current.completionAttribute });
        }
        if (previous?.stopVisible !== current.stopVisible) emit("STOP_BUTTON", { visible:current.stopVisible });
        if (endCount && !endPosition) {
          endPosition = frozen ? "AFTER_COLLECTION" : signalSeen ? "AFTER_SIGNAL_BEFORE_COLLECTION"
            : current.completionSignal ? "SAME_SAMPLE_AS_SIGNAL_ORDER_UNKNOWN" : "BEFORE_SIGNAL";
          emit("END_FIRST_OBSERVED", { relation:endPosition });
        }
        if (!signalSeen && current.completionSignal) {
          signalSeen = true;
          emit("COMPLETION_SIGNAL", { reason:current.completionSignal });
          snapshot("COMPLETION_SIGNAL", current);
        } else if (signalSeen && changed) {
          emit("POST_SIGNAL_CHANGE", { collectionState:frozen ? "FROZEN" : "OBSERVING" });
          snapshot("POST_SIGNAL_CHANGE", current);
        }
        previous = current;
      } catch {
        finish("OBSERVER_ERROR");
      }
    }

    observer = new MutationObserver(sample);
    observer.observe(document.documentElement, { subtree:true, childList:true, characterData:true, attributes:true });
    window.addEventListener("pagehide", pageExit, { once:true });
    return {
      sample,
      freeze(extracted, decision) {
        sample();
        if (stopReason || !previous) return;
        try {
          frozen = true;
          emit("COLLECTION_FROZEN", { decision });
          snapshot("COLLECTION_FROZEN", { ...previous, text:extracted });
          deadline = performance.now() + windowMs;
          const observeDeadline = () => {
            sample();
            if (!stopReason) timer = setTimeout(observeDeadline, Math.max(1, deadline - performance.now()));
          };
          timer = setTimeout(observeDeadline, windowMs);
        } catch {
          finish("OBSERVER_ERROR");
        }
      },
      finish,
    };
  }

  root.WebBridgeTurnTimeline = { create };
})(globalThis);
