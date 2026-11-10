import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "node:vm";
import {Element, fixtureMessage} from "./helpers/aud14-dom.js";
import { inspectMessageDom, replyToMessageDomInspection } from "../extension/runtime/message-dom-inspection.js";
import { collectMessageDomInspection, validateMessageDomRequest } from "../src/orchestration/message-dom-inspection.js";

const request = { tabId:7, conversationUrl:"https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
  controllerMessageId:"delivery_22222222-2222-2222-2222-222222222222", runId:"prep_33333333-3333-3333-3333-333333333333" };
const controller = `[controller_message_id:${request.controllerMessageId}]`;
const run = `[run_id:${request.runId}]`;
const primary = "[data-message-author-role]", fallback = "[data-chatgpt-search-unit-key]";
function message(role, text, attributes = {}) {
  const m = fixtureMessage(role || "user", text, {heading:!!role,explicit:!!role});
  Object.assign(m.node.attrs, attributes);
  return m.node;
}
function observe(nodes, selector = primary) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${inspectMessageDom.toString()})(request)`, {
    request, location:{href:request.conversationUrl}, document:{querySelectorAll:s => s === selector ? nodes : []} })));
}

test("same user message proves markers without exporting its text or content-bearing attributes", () => {
  const result = observe([message("user", `private conversation\n${controller}\n${run}`, {
    "data-message-id":"message-1", "data-testid":"conversation-turn-0", "data-message-content":"secret" })]);
  assert.equal(result.result, "FOUND");
  assert.equal(result.matches[0].roleProof.source, "PAGE_ACCESSIBILITY_HEADING");
  assert.equal(result.matches[0].node.attributes["data-message-id"].value, "message-1");
  assert.equal(result.matches[0].node.attributes["data-message-content"].kind, "REDACTED_CONTENT");
  assert.equal(JSON.stringify(result).includes("private conversation"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(result.scope.historyComplete, false);
});

test("CRLF markers work and truncated evidence cannot establish FOUND", () => {
  assert.equal(observe([message("user",`${controller}\r\n${run}`)]).result, "FOUND");
  const result = observe(Array.from({length:21}, () => message("user",`${controller}\n${run}`)));
  assert.equal(result.result, "NOT_CONFIRMED");
  assert.equal(result.matches.length, 20);
  assert.equal(result.scope.matchesTruncated, true);
});

test("assistant, separate messages, repeated markers and unknown roles never establish FOUND", () => {
  for (const nodes of [
    [message("assistant", `${controller}\n${run}`)],
    [message("user", controller), message("user", run)],
    [message("user", `${controller}\n${controller}\n${run}`)],
    [message(null, `${controller}\n${run}`)],
  ]) assert.equal(observe(nodes, nodes[0].getAttribute("data-message-author-role") ? primary : "article[data-testid^='conversation-turn-']").result, "NOT_CONFIRMED");
});

test("search-unit fallback alone cannot provide role proof; nested roles invalidate single-message proof", () => {
  const node = message(null, `${controller}\n${run}`, {"data-chatgpt-search-unit-key":"turn-1:user"});
  const result = observe([node], fallback);
  assert.equal(result.result, "NOT_CONFIRMED");
  assert.equal(result.selectorFallback, true);
  assert.equal(result.matches[0].roleProof, null);
  const verified = message("user", `${controller}\n${run}`);
  verified.append(new Element("DIV", {"data-message-author-role":"user"}));
  assert.equal(observe([verified]).result, "NOT_CONFIRMED");
});

test("fixed isolated DOM script targets one tab/frame and never accesses storage or delivery state", async () => {
  const replies = [], calls = [];
  const chromeApi = { tabs:{get:async id => {assert.equal(id, 7);return {url:request.conversationUrl,windowId:9};}},
    scripting:{executeScript:async input => {calls.push(input);return [{frameId:0,documentId:"chrome-doc",result:observe([message("user", `${controller}\n${run}`)])}];}} };
  await replyToMessageDomInspection(chromeApi, r => replies.push(r), {requestId:"rpc",payload:request});
  assert.deepEqual(calls[0].target, {tabId:7,frameIds:[0]});
  assert.equal(calls[0].world, "ISOLATED");
  assert.equal(calls[0].func, inspectMessageDom);
  assert.equal(replies[0].payload.result, "FOUND");
  chromeApi.tabs.get = async () => ({url:"https://chatgpt.com/"});
  await replyToMessageDomInspection(chromeApi, r => replies.push(r), {requestId:"rpc2",payload:request});
  assert.equal(replies[1].payload.errorCode, "TAB_CHANGED");
  assert.equal(calls.length, 1);
});

test("request validation rejects missing/multiple parameters and non-ChatGPT targets", () => {
  assert.equal(validateMessageDomRequest({...request,tabId:"7"}).tabId, 7);
  for (const input of [{...request,tabId:-1}, {...request,conversationUrl:[request.conversationUrl]},
    {...request,conversationUrl:"https://example.com/"}, {...request,runId:""}]) {
    assert.throws(() => validateMessageDomRequest(input), {code:"INVALID_DOM_INSPECTION_REQUEST"});
  }
});

test("RPC correlation, projection and cleanup preserve read-only boundaries", async () => {
  const transport = new EventEmitter(); transport.authenticated = true;
  transport.send = envelope => {
    assert.equal(envelope.type, "controller.message-dom.inspect");
    assert.deepEqual(envelope.payload, request);
    transport.emit("message", {type:"extension.message-dom.inspected",requestId:"other",payload:{}});
    const payload = {...observe([message("user",`${controller}\n${run}`)]),tabId:7,frameId:0,body:"secret",sessionId:"do-not-forward"};
    transport.emit("message", {type:"extension.message-dom.inspected",requestId:envelope.requestId,payload});
  };
  const result = await collectMessageDomInspection(transport, request);
  assert.equal(result.result, "FOUND");
  assert.equal(result.body, undefined); assert.equal(result.sessionId, undefined);
  assert.equal(transport.listenerCount("message"), 0); assert.equal(transport.listenerCount("state"), 0);
  transport.send = () => {};
  await assert.rejects(collectMessageDomInspection(transport, request, {timeoutMs:1}), {code:"MESSAGE_DOM_INSPECTION_TIMEOUT"});
  assert.equal(transport.listenerCount("message"), 0);
  const pending = collectMessageDomInspection(transport, request);
  transport.authenticated = false; transport.emit("state", {});
  await assert.rejects(pending, {code:"EXTENSION_DISCONNECTED"});
  assert.equal(transport.listenerCount("state"), 0);
});

test("malformed or mismatched replies fail closed without leaking listeners", async () => {
  for (const payload of [
    {tabId:8,observedUrl:request.conversationUrl,frameId:0,result:"FOUND",matches:[]},
    {tabId:7,observedUrl:request.conversationUrl,frameId:0,result:"FOUND",matches:[null]},
  ]) {
    const transport = new EventEmitter(); transport.authenticated = true;
    transport.send = m => transport.emit("message", {type:"extension.message-dom.inspected",requestId:m.requestId,payload});
    await assert.rejects(collectMessageDomInspection(transport, request), {code:"INVALID_DOM_OBSERVATION"});
    assert.equal(transport.listenerCount("message"), 0);
  }
});
