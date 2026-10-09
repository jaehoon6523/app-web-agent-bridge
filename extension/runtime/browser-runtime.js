import { defaultWebTargetProviderRegistry } from "./provider-target.js";

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
    if (change.status === "loading" || typeof change.url === "string") invalidate(tabId);
  });
  chromeApi.tabs.onRemoved?.addListener(invalidate);

  async function readTab(entry) {
    const tab = await bounded(() => chromeApi.tabs.get(entry.tabId), 2000, "CONTENT_SCRIPT_TAB_TIMEOUT");
    if (!current(entry)) throw changed();
    if (!tab || !defaultWebTargetProviderRegistry.providerForUrl(tab.url)) {
      throw new BrowserRuntimeError("WEB_TAB_UNAVAILABLE", "The Web tab is closed or unsupported.");
    }
    if (entry.url && entry.url !== tab.url) throw changed();
    entry.url = tab.url;
    return tab;
  }

  async function inject(entry) {
    entry.injectionAttempted = true;
    try {
      // Chrome's documentId pins injection to the document inspected here. The
      // content token is a separate identity and is never substituted for it.
      const inspected = await bounded(() => chromeApi.scripting.executeScript({
        target: { tabId: entry.tabId, frameIds: [0] },
        func: () => ({ url: location.href, initialized: Boolean(globalThis.ChatGptBridgeContentRuntime) }),
      }), 2000, "CONTENT_SCRIPT_INJECTION_TIMEOUT");
      if (!current(entry)) throw changed();
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
      if (!current(entry) || !results?.some(result => result.documentId === entry.chromeDocumentId)) throw changed();
    } catch (error) {
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
    try {
      const tab = await readTab(entry);
      let response;
      try {
        response = await bounded(() => chromeApi.tabs.sendMessage(entry.tabId,
          { type: "agent.ping" }, entry.chromeDocumentId ? { documentId: entry.chromeDocumentId } : { frameId: 0 }),
        2000, "CONTENT_SCRIPT_MESSAGE_TIMEOUT");
      } catch (error) {
        if (!current(entry)) throw changed();
        const missingReceiver = /Could not establish connection\. Receiving end does not exist\.?$/u.test(error.message);
        if (!missingReceiver) throw error instanceof BrowserRuntimeError ? error
          : new BrowserRuntimeError("CONTENT_SCRIPT_CONNECTION_FAILED", error.message, { tabId: entry.tabId }, error);
        // Allow document_idle automatic injection one poll before falling back.
        if (tab.status !== "loading" && entry.missingReceiver && !entry.injectionAttempted && entry.waiters.size) await inject(entry);
        entry.missingReceiver = true;
      }
      if (!current(entry)) throw changed();
      if (response !== undefined) {
        if (!response?.ok || typeof response.documentId !== "string" || response.frameId !== 0) {
          throw new BrowserRuntimeError("CONTENT_SCRIPT_PROTOCOL_INVALID", "Content readiness reply has no exact document identity.");
        }
        await readTab(entry);
        if (entry.contentDocumentId && entry.contentDocumentId !== response.documentId) throw changed();
        entry.contentDocumentId = response.documentId;
        entry.responded = true;
        for (const waiter of [...entry.waiters]) {
          if (!waiter.requireComposer || response.ready === true) finish(waiter, null, response);
          else if (response.pageStatus && !["READY", "UI_CONTRACT_CHANGED"].includes(response.pageStatus)) {
            finish(waiter, new BrowserRuntimeError(response.pageStatus, response.message || response.pageStatus));
          }
        }
      }
    } catch (error) {
      fail(entry, error);
      if (error.code === "WEB_DOCUMENT_CHANGED" && current(entry)) invalidate(entry.tabId);
    } finally {
      entry.running = false;
      if (current(entry) && entry.waiters.size) entry.timer = setTimeout(() => void tick(entry), 350);
    }
  }

  function waitForContentScript(tabId, timeoutMs = 20_000, requireComposer = false) {
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
      entry.contentDocumentId = null;
      entry.chromeDocumentId = null;
      entry.responded = false;
    }
    return new Promise((resolve, reject) => {
      const waiter = { entry, requireComposer, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        finish(waiter, new BrowserRuntimeError(entry.responded && requireComposer ? "UI_CONTRACT_CHANGED" : "CONTENT_SCRIPT_UNAVAILABLE",
          entry.responded && requireComposer ? "Web composer is unavailable." : "Web content script is unavailable."));
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
