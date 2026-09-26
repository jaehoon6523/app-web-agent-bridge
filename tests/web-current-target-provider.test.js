import assert from "node:assert/strict";
import test from "node:test";

import {
  isPendingRootPromotion,
  resolveCurrentUserTarget,
  resolvePreparedSessionTarget,
} from "../extension/runtime/current-target.js";
import { createWebTargetProviderRegistry } from "../extension/runtime/provider-target.js";
import { normalizeExtensionState } from "../extension/runtime/storage.js";

function testProvider() {
  return Object.freeze({
    provider:"TEST_WEB",
    rootUrl:"https://example.test/",
    urlPatterns:Object.freeze(["https://example.test/*"]),
    canonicalize(value) {
      let url;
      try { url = new URL(value); } catch { return null; }
      if (url.protocol !== "https:" || url.hostname !== "example.test") return null;
      url.search = "";
      url.hash = "";
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : url.pathname;
      return `${url.origin}${path}`;
    },
    conversationIdFromUrl(value) {
      const canonical = this.canonicalize(value);
      if (!canonical) return null;
      const parts = new URL(canonical).pathname.split("/").filter(Boolean);
      return parts[0] === "chat" && parts[1] ? decodeURIComponent(parts[1]) : null;
    },
  });
}

test("current target resolution uses the registered provider instead of ChatGPT URL rules", async () => {
  const provider = testProvider();
  const registry = createWebTargetProviderRegistry([provider]);
  const tab = { id:11, windowId:3, url:"https://example.test/chat/abc" };
  const page = { ok:true, ready:true, busy:false, generating:false,
    url:tab.url, conversationId:"abc", documentId:"doc-11", frameId:0 };
  const updates = [];
  const target = await resolveCurrentUserTarget({
    registry,
    state:{ bindingStatus:"NEEDS_REBIND", lastActiveWebTarget:null },
    tabs:{
      query:async ({ url }) => {
        assert.deepEqual(url, ["https://example.test/*"]);
        return [tab];
      },
      get:async () => tab,
      sendMessage:async () => page,
    },
    store:{ update:async (patch) => { updates.push(patch); return patch; } },
    waitForContentScript:async () => {},
  });
  assert.equal(target.provider, "TEST_WEB");
  assert.equal(target.conversationUrl, tab.url);
  assert.equal(target.conversationId, "abc");
  assert.equal(updates.at(-1).lastActiveWebTarget.provider, "TEST_WEB");
});

test("prepared target and root promotion use the persisted provider identity", async () => {
  const provider = testProvider();
  const registry = createWebTargetProviderRegistry([provider]);
  const state = {
    webProvider:"TEST_WEB", bindingStatus:"BOUND", tabId:7,
    conversationUrl:"https://example.test/chat/judge", conversationId:"judge",
  };
  const target = await resolvePreparedSessionTarget({
    registry,
    state,
    tabs:{
      get:async () => ({ id:7, windowId:1, url:state.conversationUrl }),
      sendMessage:async () => ({ ok:true, ready:true, busy:false, generating:false,
        url:state.conversationUrl, conversationId:"judge", documentId:"doc-7", frameId:0 }),
    },
    waitForContentScript:async () => {},
  });
  assert.equal(target.provider, "TEST_WEB");
  assert.equal(isPendingRootPromotion({
    registry,
    state:{ ...state, bindingStatus:"ROOT_READY", conversationUrl:provider.rootUrl,
      conversationId:null, currentDeliveryId:"d1" },
    tab:{ id:7, url:"https://example.test/chat/created" },
    activeRequestId:"d1",
  }), true);
});

test("legacy ChatGPT state is normalized into provider-neutral binding fields", () => {
  const state = normalizeExtensionState({
    lastBoundSessionId:"s1", lastBoundRunId:"r1",
    bindingStatus:"ROOT_READY",
    tabId:1, windowId:2, documentId:"doc-1", frameId:0,
    conversationUrl:"https://chatgpt.com/", conversationId:null,
    lastActiveChatGptTarget:{
      tabId:1, windowId:2, documentId:"doc-1", frameId:0,
      conversationUrl:"https://chatgpt.com/", conversationId:null, observedAt:1,
    },
  });
  assert.equal(state.webProvider, "CHATGPT_WEB");
  assert.equal(state.lastActiveWebTarget.provider, "CHATGPT_WEB");
  assert.equal(state.bindingStatus, "ROOT_READY");
});
