import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {fixtureMessage} from "./helpers/aud14-dom.js";

const registrySource = fs.readFileSync(new URL("../extension/runtime/page-provider-registry.js", import.meta.url), "utf8");
const contentSource = fs.readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

function contract(provider, host) {
  const noop = () => null;
  return {
    provider,
    rootUrl:`https://${host}/`,
    matches:(value) => {
      try { return new URL(value).hostname === host; } catch { return false; }
    },
    assertContract:() => true,
    identifyPage:noop,
    detectAuthentication:noop,
    detectComposer:noop,
    readConversationIdentity:noop,
    readMessages:() => [],
    findSendControl:noop,
    submitPrompt:async () => {},
    detectGeneration:() => false,
    cancelGeneration:() => false,
    extractAssistantResponse:() => "",
    inspectPageState:noop,
    evidence:() => ({}),
    resetEvidence:() => {},
    mutationRoot:noop,
    canonicalizeUrl:(value) => {
      try {
        const url = new URL(value);
        if (url.hostname !== host || url.protocol !== "https:") return null;
        url.search = "";
        url.hash = "";
        return url.href;
      } catch { return null; }
    },
    conversationIdFromUrl:() => null,
  };
}

test("page provider registry resolves by URL and fails closed on duplicate providers", () => {
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(registrySource, context, { filename:"page-provider-registry.js" });
  const registry = context.WebBridgePageProviders;
  assert.ok(registry);
  const first = registry.register(contract("TEST_A", "a.example"));
  assert.equal(registry.resolve("https://a.example/chat"), first);
  assert.equal(registry.resolve("https://unknown.example/"), null);
  assert.throws(() => registry.register(contract("TEST_A", "other.example")), /already registered/u);

  const overlap = contract("TEST_B", "b.example");
  overlap.matches = () => true;
  registry.register(overlap);
  assert.throws(() => registry.resolve("https://a.example/chat"), /more than one provider/u);
});

test("manifest loads the provider contract and ChatGPT page adapter before content orchestration", () => {
  const scripts = manifest.content_scripts[0].js;
  const registryIndex = scripts.indexOf("runtime/page-provider-registry.js");
  const adapterIndex = scripts.indexOf("runtime/providers/chatgpt-page.js");
  const contentIndex = scripts.indexOf("content.js");
  assert.ok(registryIndex >= 0);
  assert.ok(adapterIndex > registryIndex);
  assert.ok(contentIndex > adapterIndex);
});

test("ChatGPT page adapter waits for a persistent conversation ID", () => {
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(registrySource, context);
  vm.runInNewContext(fs.readFileSync(new URL("../extension/runtime/providers/chatgpt-page.js", import.meta.url), "utf8"), context);
  const provider = context.WebBridgePageProviders.provider("CHATGPT_WEB");
  for (const id of ["local-chatgpt:temporary", "local-chatgpt%3Atemporary", "WEB:temporary"]) {
    assert.equal(provider.conversationIdFromUrl("https://chatgpt.com/c/" + id), null);
  }
  assert.equal(provider.conversationIdFromUrl("https://chatgpt.com/c/created"), "created");
});

test("ChatGPT search message units preserve marker text, order and unique stable IDs", () => {
  const units=[['user','u1','[controller_message_id:d1]\n[run_id:prep_r1]'],['assistant','a1 a1','확인 질문']]
    .map(([role,id,text])=>fixtureMessage(role,text,{search:true,explicit:false,id}).node);
  const groups=Object.fromEntries(['composer','sendButton','stopButton','message','messageContainer','messageContent'].map(k=>[k,['test']]));
  const context={URL,document:{querySelectorAll:()=>units},ChatGptBridgeSelectors:{version:'test',groups,resolveSendButtonState(){}},
    ChatGptBridgeResponseText:{elementText:el=>el.textContent}};
  context.globalThis=context;
  vm.runInNewContext(registrySource,context);
  vm.runInNewContext(fs.readFileSync(new URL('../extension/runtime/providers/chatgpt-page.js',import.meta.url),'utf8'),context);
  const provider=context.WebBridgePageProviders.provider('CHATGPT_WEB');
  assert.deepEqual(JSON.parse(JSON.stringify(provider.readMessages().map(({id,role,text,index})=>({id,role,text,index})))),[
    {id:'u1',role:'user',text:'[controller_message_id:d1]\n[run_id:prep_r1]',index:0},
    {id:'a1',role:'assistant',text:'확인 질문',index:1}]);
  units[1].attrs['data-chatgpt-search-message-ids']='a1 a2';
  assert.throws(()=>provider.readMessages(),{code:'AMBIGUOUS_PROMPT_BINDING'});
});

test("content orchestration no longer embeds ChatGPT DOM or URL rules", () => {
  for (const token of [
    "ChatGptBridgeSelectors",
    "ChatGptBridgeResponseText",
    "CHATGPT_HOSTS",
    "#prompt-textarea",
    "data-message-author-role",
    "selectorTelemetry",
    "https://chatgpt.com/",
    "document.querySelector(",
  ]) assert.equal(contentSource.includes(token), false, token);
  assert.match(contentSource, /WebBridgePageProviders/u);
  assert.match(contentSource, /submitPrompt\(text, signal, \{ assertCanMutate \}\)/u);
});
