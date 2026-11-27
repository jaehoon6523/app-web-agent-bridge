import { defaultWebTargetProviderRegistry } from "./provider-target.js";
import { diagnosticMetadata } from "./document-binding.js";

export class BrowserRuntimeError extends Error {
  constructor(code, message, details = null, cause = undefined) {
    super(message, { cause });
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.details = details;
  }
}

function bounded(operation, ms, code) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => { timer = setTimeout(() => reject(
      new BrowserRuntimeError(code, "Chrome did not finish the content readiness operation.")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function contentScriptFiles(chromeApi, url) {
  const provider = defaultWebTargetProviderRegistry.providerForUrl(url);
  const entry = chromeApi.runtime.getManifest().content_scripts?.find(item =>
    item.matches?.some(pattern => provider?.urlPatterns.includes(pattern)));
  if (!entry?.js?.length) throw new BrowserRuntimeError(
    "CONTENT_SCRIPT_CONFIG_INVALID", "Web content script configuration is missing.");
  return entry.js;
}

export function createBrowserRuntime(chromeApi) {
  // Entries survive caller timeouts. A failed injection is not retried until navigation.
  const entries = new Map();
  const current = entry => entries.get(entry.tabId) === entry;
  const changed = () => new BrowserRuntimeError("WEB_DOCUMENT_CHANGED",
    "The Web document changed during content preparation; prepare it again.");

  const readinessDetails = entry => ({ tabId:entry.tabId, tabUrl:entry.url ?? null,
    chromeDocumentId:entry.chromeDocumentId ?? null, contentDocumentId:entry.contentDocumentId ?? null,
    responded:entry.responded ?? false, pingAttempts:entry.pingAttempts ?? 0,
    injectionAttempted:entry.injectionAttempted, missingReceiver:entry.missingReceiver,
    lastReadiness:entry.lastReadiness ?? null,
    lastInspectionError:entry.lastInspectionError ?? null });

  function finish(waiter, error, response) {
    clearTimeout(waiter.timer);
    waiter.entry.waiters.delete(waiter);
    if (error) waiter.reject(error); else waiter.resolve(response);
  }
  function fail(entry, error) {
    for (const waiter of [...entry.waiters]) finish(waiter, error);
  }
  function invalidate(tabId) {
    const entry = entries.get(tabId);
    if (!entry) return;
    entries.delete(tabId);
    clearTimeout(entry.timer);
    fail(entry, changed());
  }
  chromeApi.tabs.onUpdated?.addListener((tabId, change) => {
    const entry = entries.get(tabId);
    if (change.status === "loading" || typeof change.url === "string") {
      if (entry?.initialUrl && entry.waiters.size && (!change.url
        || (change.url === "about:blank" && !entry.url)
        || defaultWebTargetProviderRegistry.canonicalize(change.url) === entry.initialUrl)) {
        // One Chrome navigation can emit several loading and URL updates.
        // Keep the same waiter, and discard any reply from an earlier document.
        entry.navigationVersion++;
        entry.waitingForFirstCommit = true;
        entry.url = null;
        entry.chromeDocumentId = null;
        entry.contentDocumentId = null;
        entry.injectionAttempted = false;
        entry.missingReceiver = false;
        entry.error = null;
        return;
      }
      // The first commit has no previous document to invalidate.
      if (entry?.waitingForFirstCommit && !entry.initialUrl) return;
      invalidate(tabId);
    } else if (change.status === "complete" && entry?.waitingForFirstCommit && !entry.running) {
      clearTimeout(entry.timer);
      entry.timer = null;
      void tick(entry);
    }
  });
  chromeApi.tabs.onRemoved?.addListener(invalidate);

  async function readTab(entry) {
    const registry = defaultWebTargetProviderRegistry;
    const tab = await bounded(() => chromeApi.tabs.get(entry.tabId), 2000, "CONTENT_SCRIPT_TAB_TIMEOUT");
    if (!current(entry)) throw changed();
    if (entry.initialUrl) {
      const matchesTarget = url => registry.canonicalize(url) === entry.initialUrl;
      const provisional = entry.waitingForFirstCommit && (!tab?.url || tab.url === "about:blank");
      if ((!provisional && !matchesTarget(tab?.url)) || (tab?.pendingUrl && !matchesTarget(tab.pendingUrl))) throw changed();
      if (provisional || tab.pendingUrl || tab.status === "loading") return null;
    }
    if (!entry.url && tab?.status === "loading" && (!tab.url || tab.url === "about:blank")
      && registry.providerForUrl(tab.pendingUrl)) {
      entry.waitingForFirstCommit = true;
      return null;
    }
    entry.waitingForFirstCommit = false;
    if (!tab || !registry.providerForUrl(tab.url)) {
      throw new BrowserRuntimeError("WEB_TAB_UNAVAILABLE", "The Web tab is closed or unsupported.");
    }
    if (entry.url && entry.url !== tab.url) throw changed();
    entry.url = tab.url;
    return tab;
  }

  async function inject(entry, navigationVersion) {
    entry.injectionAttempted = true;
    try {
      // Chrome's documentId pins injection to the document inspected here. The
      // content token is a separate identity and is never substituted for it.
      const inspected = await bounded(() => chromeApi.scripting.executeScript({
        target: { tabId: entry.tabId, frameIds: [0] },
        func: () => ({ url: location.href, initialized: Boolean(globalThis.ChatGptBridgeContentRuntime) }),
      }), 2000, "CONTENT_SCRIPT_INJECTION_TIMEOUT");
      if (!current(entry)) throw changed();
      if (entry.navigationVersion !== navigationVersion) return;
      const top = inspected?.find(result => result.frameId === 0);
      if (!top?.documentId || top.result?.url !== entry.url) throw changed();
      entry.chromeDocumentId = top.documentId;
      // Automatic injection may have finished between the missing receiver and
      // this probe. Ping it again without replacing any provider or job state.
      if (top.result.initialized) return;
      const results = await bounded(() => chromeApi.scripting.executeScript({
        target: { tabId: entry.tabId, documentIds: [entry.chromeDocumentId] },
        files: contentScriptFiles(chromeApi, entry.url),
      }), 5000, "CONTENT_SCRIPT_INJECTION_TIMEOUT");
      if (entry.navigationVersion !== navigationVersion) return;
      if (!current(entry) || !results?.some(result => result.documentId === entry.chromeDocumentId)) throw changed();
    } catch (error) {
      if (entry.navigationVersion !== navigationVersion) return;
      if (error?.code === "WEB_DOCUMENT_CHANGED") throw error;
      const failure = new BrowserRuntimeError("CONTENT_SCRIPT_INJECTION_FAILED",
        "Content script injection failed: " + error.message,
        { tabId: entry.tabId, stage: "INJECTION", causeCode: error.code ?? null }, error);
      entry.error = failure;
      throw failure;
    }
  }

  async function tick(entry) {
    if (entry.running || !current(entry) || !entry.waiters.size) return;
    entry.running = true;
    const navigationVersion = entry.navigationVersion;
    try {
      const tab = await readTab(entry);
      if (!tab || entry.navigationVersion !== navigationVersion) return;
      let response;
      try {
        entry.pingAttempts = (entry.pingAttempts ?? 0) + 1;
        response = await bounded(() => chromeApi.tabs.sendMessage(entry.tabId,
          { type: "agent.ping" }, entry.chromeDocumentId ? { documentId: entry.chromeDocumentId } : { frameId: 0 }),
        2000, "CONTENT_SCRIPT_MESSAGE_TIMEOUT");
      } catch (error) {
        if (!current(entry)) throw changed();
        if (entry.navigationVersion !== navigationVersion) return;
        if (entry.initialUrl && error.code === "CONTENT_SCRIPT_MESSAGE_TIMEOUT") {
          // An initial renderer may miss a readiness probe while the page hydrates.
          // The original readiness deadline still bounds this work.
          entry.lastInspectionError = { code:error.code };
          return;
        }
        const missingReceiver = /Could not establish connection\. Receiving end does not exist\.?$/u.test(error.message);
        if (!missingReceiver) throw error instanceof BrowserRuntimeError ? error
          : new BrowserRuntimeError("CONTENT_SCRIPT_CONNECTION_FAILED", error.message, { tabId: entry.tabId }, error);
        // Allow document_idle automatic injection one poll before falling back.
        if (tab.status !== "loading" && entry.missingReceiver && !entry.injectionAttempted && entry.waiters.size) await inject(entry, navigationVersion);
        if (entry.navigationVersion !== navigationVersion) return;
        entry.missingReceiver = true;
      }
      if (!current(entry)) throw changed();
      if (entry.navigationVersion !== navigationVersion) return;
      if (response !== undefined) {
        if (!response?.ok || typeof response.documentId !== "string" || response.frameId !== 0) {
          throw new BrowserRuntimeError("CONTENT_SCRIPT_PROTOCOL_INVALID", "Content readiness reply has no exact document identity.");
        }
        if (!await readTab(entry) || entry.navigationVersion !== navigationVersion) return;
        if (entry.contentDocumentId && entry.contentDocumentId !== response.documentId) throw changed();
        entry.contentDocumentId = response.documentId;
        entry.responded = true;
        // Keep only readiness metadata; never retain prompt or response content.
        entry.lastReadiness = diagnosticMetadata(Object.fromEntries(["ok", "ready", "pageUrl", "url", "pageStatus", "composerPresent",
          "busy", "activeRequestId", "generating", "conversationId",
          "provider", "selectorVersion", "runtimeVersion", "documentId", "frameId", "diagnostics", "pageState", "inspectionError"]
          .filter(key => response[key] !== undefined).map(key => [key, response[key]])));
        if (entry.lastReadiness.inspectionError) entry.lastInspectionError = entry.lastReadiness.inspectionError;
        for (const waiter of [...entry.waiters]) {
          if (!waiter.requireComposer || response.ready === true) finish(waiter, null, response);
          else if (response.pageStatus && !["READY", "UI_CONTRACT_CHANGED"].includes(response.pageStatus)) {
            finish(waiter, new BrowserRuntimeError(response.pageStatus, response.message || response.pageStatus,
              { readiness:readinessDetails(entry) }));
          }
        }
      }
    } catch (error) {
      error.details = { ...(error.details ?? {}), readiness:readinessDetails(entry) };
      fail(entry, error);
      if (error.code === "WEB_DOCUMENT_CHANGED" && current(entry)) invalidate(entry.tabId);
    } finally {
      entry.running = false;
      if (current(entry) && entry.waiters.size) entry.timer = setTimeout(() => void tick(entry), 350);
    }
  }

  function waitForContentScript(tabId, timeoutMs = 20_000, requireComposer = false, initialUrl = null) {
    if (!Number.isSafeInteger(tabId) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError("A tab ID and positive readiness timeout are required."));
    }
    let entry = entries.get(tabId);
    if (!entry) {
      entry = { tabId, waiters: new Set(), running: false, injectionAttempted: false, missingReceiver: false };
      entries.set(tabId, entry);
    }
    if (entry.error) return Promise.reject(entry.error);
    if (!entry.running && entry.waiters.size === 0) {
      // A new call after an idle interval prepares the current target afresh.
      // Injection history stays cached; only a navigation event resets it.
      entry.url = null;
      entry.initialUrl = initialUrl;
      entry.navigationVersion = 0;
      entry.waitingForFirstCommit = Boolean(initialUrl);
      entry.contentDocumentId = null;
      entry.chromeDocumentId = null;
      entry.responded = false;
      entry.pingAttempts = 0;
      entry.lastReadiness = null;
      entry.lastInspectionError = null;
    }
    return new Promise((resolve, reject) => {
      const waiter = { entry, requireComposer, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        finish(waiter, new BrowserRuntimeError(entry.responded && requireComposer ? "UI_CONTRACT_CHANGED" : "CONTENT_SCRIPT_UNAVAILABLE",
          entry.responded && requireComposer ? "Web composer is unavailable." : "Web content script is unavailable.",
          { timeoutMs, requireComposer, readiness:readinessDetails(entry) }));
        if (!entry.waiters.size) clearTimeout(entry.timer);
      }, timeoutMs);
      entry.waiters.add(waiter);
      if (!entry.running && !entry.timer) void tick(entry);
      else if (!entry.running) { clearTimeout(entry.timer); entry.timer = null; void tick(entry); }
    });
  }

  async function focusTab(tab) {
    await chromeApi.windows.update(tab.windowId, { focused: true });
    await chromeApi.tabs.update(tab.id, { active: true });
  }
  return { focusTab, waitForContentScript };
}
