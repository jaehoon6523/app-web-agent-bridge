import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createReconnectController } from '../extension/runtime/reconnect.js';

function fixture({ generic = false, voice = false, send = true, duplicate = false,
  editors = 1, known = false, excluded = false } = {}) {
  let provider; const controls = [], fields = [];
  class HTMLElement {
    disabled = false; hidden = false; removed = false; textContent = ''; tagName = 'DIV';
    getBoundingClientRect() { return { width:500, height:40 }; }
    get innerText() { return this.textContent; }
    getAttribute(name) { return this.attributes?.[name] ?? null; }
    focus() {} dispatchEvent() {}
    matches(selector) { return selector === "[contenteditable='true'][role='textbox']"; }
    closest(selector) {
      if (selector.includes("[role='dialog']")) return excluded ? {} : null;
      if (selector.includes("#composer")) return known ? form : null;
      if (selector === 'form' || selector.includes("[role='main']")) return form;
      return null;
    }
  }
  const form = { querySelectorAll(selector) { return controls.filter(control => !control.removed && control.selectors.includes(selector)); } };
  function control(selectors) {
    const item = new HTMLElement(); item.selectors = selectors; item.clicks = 0;
    item.click = () => { item.clicks++; }; controls.push(item); return item;
  }
  if (generic) control(["form button[type='submit']"]);
  if (voice) control(["button[aria-label='Start voice input']"]);
  if (send) control(["button[data-testid='send-button']", "button[aria-label='Send prompt']"]);
  if (duplicate) control(["button[aria-label='Send message']"]);
  for (let i = 0; i < editors; i++) {
    const item = new HTMLElement(); item.attributes = { role:'textbox', contenteditable:'true' };
    fields.push(item);
  }
  const context = vm.createContext({ URL, location:{ href:'https://chatgpt.com/' }, HTMLElement,
    HTMLTextAreaElement:class extends HTMLElement {}, HTMLInputElement:class extends HTMLElement {},
    InputEvent:class {}, Event:class {}, DOMException, AbortController,
    getComputedStyle:element => ({ display:element.hidden ? 'none' : 'block', visibility:'visible' }),
    setTimeout:(fn, delay) => setTimeout(fn, Math.min(delay, 10)), clearTimeout,
    document:{ title:'', body:{ innerText:'' },
      querySelectorAll(selector) {
        if (["[contenteditable='true'][role='textbox']", "[contenteditable='true']", "[role='textbox']"].includes(selector)) return fields.filter(field => !field.removed);
        return form.querySelectorAll(selector);
      }, createRange:() => ({ selectNodeContents() {} }), execCommand:() => false },
    window:{ getSelection:() => ({ removeAllRanges() {}, addRange() {} }) },
    ChatGptBridgeResponseText:{ elementText:element => element.innerText },
    WebBridgePageProviders:{ provider:() => provider, register:value => { provider = value; } }, console:{ warn() {} } });
  const base = new URL('../extension/', import.meta.url);
  for (const file of ['selectors/selector-version.js', 'selectors/composer-selectors.js', 'selectors/send-button-selectors.js',
    'selectors/stop-button-selectors.js', 'selectors/message-selectors.js', 'runtime/providers/chatgpt-page.js']) {
    vm.runInContext(fs.readFileSync(new URL(file, base), 'utf8'), context);
  }
  return { provider, controls, fields };
}

test('fallback dispatch selects one explicit send control and deduplicates selector aliases', async () => {
  const f = fixture({ generic:true, voice:true });
  assert.equal(f.provider.detectComposer().present, true);
  assert.equal(f.provider.findSendControl().state, 'ENABLED');
  await f.provider.submitPrompt('Fixture prompt', new AbortController().signal);
  assert.deepEqual(f.controls.map(control => control.clicks), [0, 0, 1]);
});

for (const known of [false, true]) {
  test(`voice plus generic submit never authorizes dispatch (known container: ${known})`, async () => {
    const f = fixture({ generic:true, voice:true, send:false, known });
    assert.equal(f.provider.detectComposer().present, true);
    f.fields[0].textContent = 'Fixture prompt';
    assert.equal(f.provider.findSendControl().state, 'UNKNOWN');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60);
    try { await assert.rejects(f.provider.submitPrompt('Fixture prompt', controller.signal), { name:'AbortError' }); }
    finally { clearTimeout(timeout); }
    assert.ok(f.controls.every(control => control.clicks === 0));
  });
}

test('generic submit alone and multiple editors do not identify a fallback composer', () => {
  assert.equal(fixture({ generic:true, send:false }).provider.detectComposer().present, false);
  assert.equal(fixture({ editors:2 }).provider.detectComposer().present, false);
  assert.equal(fixture({ excluded:true }).provider.detectComposer().present, false);
});

test('two distinct explicit send controls remain unknown instead of selecting the first', () => {
  const f = fixture({ duplicate:true }); f.fields[0].textContent = 'Fixture prompt';
  assert.equal(f.provider.findSendControl().state, 'UNKNOWN');
  assert.ok(f.controls.every(control => control.clicks === 0));
});

for (const change of ['replace-editor', 'disable-send', 'hide-send', 'add-send']) {
  test(`dispatch rechecks the same editor and unique enabled control after ${change}`, async () => {
    const f = fixture(); let checks = 0;
    await assert.rejects(f.provider.submitPrompt('Fixture prompt', new AbortController().signal, {
      assertCanMutate() {
        if (++checks !== 2) return;
        if (change === 'replace-editor') f.fields[0].removed = true;
        if (change === 'disable-send') f.controls[0].disabled = true;
        if (change === 'hide-send') f.controls[0].hidden = true;
        if (change === 'add-send') f.controls.push(Object.assign(Object.create(Object.getPrototypeOf(f.controls[0])),
          f.controls[0], { selectors:["button[aria-label='Send message']"] }));
      },
    }), { code:'UI_CONTRACT_CHANGED' });
    assert.ok(f.controls.every(control => control.clicks === 0));
  });
}

test('4409 cancels scheduled retries until an explicit request', async () => {
  let callback = null, connections = 0;
  const controller = createReconnectController({ connect:async () => { connections++; }, connected:() => false,
    onError() { throw new Error('Unexpected retry'); }, setTimer:fn => { callback = fn; return 1; }, clearTimer:() => { callback = null; } });
  controller.schedule(4001); assert.ok(callback);
  controller.schedule(4409); assert.equal(callback, null);
  controller.schedule(0); assert.equal(callback, null); assert.equal(connections, 0);
  controller.requested(); controller.schedule(0); assert.ok(callback); await callback(); assert.equal(connections, 1);
});

test('late retry failure does not restart reconnect after 4409', async () => {
  let callback, reject;
  const controller = createReconnectController({ connect:() => new Promise((_, failure) => { reject = failure; }),
    connected:() => false, onError() { throw new Error('Must retain rejection diagnostic'); },
    setTimer:fn => { callback = fn; return 1; }, clearTimer:() => { callback = null; } });
  controller.schedule(4001); const scheduled = callback; callback = null;
  const pending = scheduled(); controller.schedule(4409);
  reject(new Error('Late failure')); await pending; assert.equal(callback, null);
});
