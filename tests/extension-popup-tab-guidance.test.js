import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { inspectChatGptTabs } from '../extension/runtime/tab-diagnostics.js';

const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const rootUrl = 'https://chatgpt.com/';
const readyTab = { tabId: 7, url: rootUrl, startUrlConfirmed: true,
  reachable: true, ready: true, composerPresent: true,
  busy: false, generating: false, runtimeVersion: '1.2.3' };

function fixture() {
  const node = () => ({ value: '', textContent: '', checked: false, disabled: false, handlers: {}, options: [],
    addEventListener(type, handler) { this.handlers[type] = handler; },
    replaceChildren(...options) { this.options = options; this.value = options[0]?.value ?? ''; } });
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  let stateResponse = { ok: true, state: { connected: true, extensionVersion: '1.2.3' } };
  let inspect = () => ({ ok: true, result: [] });
  let open = () => ({ ok: true });
  const context = vm.createContext({ URLSearchParams, URL, Blob, setTimeout,
    document: { querySelector: selector => nodes[selector.slice(1)], createElement: node },
    chrome: { runtime: { onMessage: { addListener() {} }, async sendMessage({ type }) {
      if (type === 'bridge.getState') return stateResponse;
      if (type === 'bridge.inspectTabs') return inspect();
      return open(type);
    } } } });
  vm.runInContext(popup, context, { filename: 'popup.js' });
  return { nodes, context, setStateResponse(value) { stateResponse = value; },
    setInspection(callback) { inspect = callback; }, setOpen(callback) { open = callback; },
    async show(tab = readyTab, connected = true) {
      await vm.runInContext('refresh()', context);
      stateResponse = { ok: true, state: { connected, extensionVersion: '1.2.3' } };
      inspect = () => ({ ok: true, result: tab ? [tab] : [] });
      await vm.runInContext('refresh()', context);
      await nodes.inspectTabs.handlers.click();
      return { disabled: nodes.choosePreparationTab.disabled, reason: nodes.tabNextReason.textContent };
    } };
}

test('popup shows the first applicable Korean action and button state', async t => {
  const cases = [
    ['controller first, even with version mismatch', { ...readyTab, runtimeVersion: 'old' }, false, true, /컨트롤러에 연결/],
    ['no selected tab', null, true, true, /탭을 선택하고 다시 확인/],
    ['no content response before version mismatch', { ...readyTab, reachable: false, runtimeVersion: 'old' }, true, true, /콘텐츠 응답이 없습니다/],
    ['version mismatch before URL and activity', { ...readyTab, runtimeVersion: 'old', startUrlConfirmed: false, busy: true }, true, true, /콘텐츠 버전이 다릅니다.*안전할 때.*새로고침/],
    ['unknown version', { ...readyTab, runtimeVersion: null }, true, true, /버전을 확인할 수 없습니다/],
    ['wrong URL before activity', { ...readyTab, startUrlConfirmed: false, generating: true }, true, true, /시작 화면/],
    ['active', { ...readyTab, busy: true, composerPresent: false }, true, true, /작업 또는 생성이 끝날 때까지/],
    ['generating', { ...readyTab, generating: true }, true, true, /작업 또는 생성이 끝날 때까지/],
    ['missing composer', { ...readyTab, composerPresent: false }, true, true, /입력창이 준비될 때까지/],
    ['UI not ready', { ...readyTab, ready: false }, true, true, /입력창이 준비될 때까지/],
    ['unknown busy', { ...readyTab, busy: null }, true, true, /작업 또는 생성 상태를 확인할 수 없습니다/],
    ['unknown generating', { ...readyTab, generating: null }, true, true, /작업 또는 생성 상태를 확인할 수 없습니다/],
    ['unknown composer', { ...readyTab, composerPresent: null }, true, true, /다시 확인/],
    ['unknown ready', { ...readyTab, ready: null }, true, true, /다시 확인/],
    ['unknown reachability', { ...readyTab, reachable: null }, true, true, /콘텐츠 응답/],
    ['fully ready', readyTab, true, false, /화면만 이동하며 전송하지 않습니다/],
  ];
  for (const [name, tab, connected, disabled, reason] of cases) await t.test(name, async () => {
    const result = await fixture().show(tab, connected);
    assert.equal(result.disabled, disabled);
    assert.match(result.reason, reason);
  });
});

test('popup uses the raw URL verdict from Chrome tab diagnostics', async t => {
  const scenarios = [
    { name: 'exact root', queried: rootUrl, document: rootUrl, observed: rootUrl, expected: true },
    { name: 'query on root', queried: rootUrl + '?source=fixture', document: rootUrl, observed: rootUrl, expected: false },
    { name: 'fragment in document', queried: rootUrl, document: rootUrl + '#changed', observed: rootUrl, expected: false },
    { name: 'observed navigation off-site', queried: rootUrl, document: rootUrl, observed: 'https://example.org/', expected: false },
    { name: 'missing raw document URL', queried: rootUrl, observed: rootUrl, expected: null },
    { name: 'failed tab recheck', queried: rootUrl, document: rootUrl, expected: null },
  ];
  for (const { name, queried, document, observed, expected } of scenarios) await t.test(name, async () => {
    const [tab] = await inspectChatGptTabs({
      query: async () => [{ id: 7, url: queried }],
      get: async () => {
        if (!observed) throw new Error('Tab lookup failed');
        return { id: 7, url: observed };
      },
      sendMessage: async () => ({ ...readyTab, ok: true, pageUrl: document }),
    });
    assert.equal(tab.url, rootUrl);
    assert.equal(tab.startUrlConfirmed, expected);
    const { disabled, reason } = await fixture().show(tab);
    assert.equal(disabled, expected !== true);
    assert.match(reason, expected === true ? /전송하지 않습니다/ : expected === false ? /시작 화면.*열고/ : /주소를 확인할 수 없습니다/);
  });
});

test('failed controller-state refresh removes ready guidance', async () => {
  const f = fixture();
  assert.equal((await f.show()).disabled, false);
  f.setStateResponse({ ok: false, error: 'service worker unavailable' });
  await vm.runInContext('refresh()', f.context);
  assert.equal(f.nodes.choosePreparationTab.disabled, true);
  assert.match(f.nodes.tabNextReason.textContent, /컨트롤러에 연결/);
  assert.doesNotMatch(f.nodes.tabNextReason.textContent, /화면만 이동/);
});

test('inspection failure preserves authentication priority and its log survives a state failure', async () => {
  const f = fixture();
  await f.show(readyTab, false);
  f.setInspection(() => { throw new Error('inspection transport rejected'); });
  await f.nodes.inspectTabs.handlers.click();
  assert.equal(f.nodes.choosePreparationTab.disabled, true);
  assert.match(f.nodes.tabNextReason.textContent, /컨트롤러에 연결/);
  f.setStateResponse({ ok: false, error: 'service worker unavailable' });
  await vm.runInContext('refresh()', f.context);
  assert.equal(vm.runInContext('tabDiagnosticText', f.context), 'inspection transport rejected');

  await f.show();
  f.setInspection(() => ({ ok: false, error: 'inspection unavailable' }));
  await f.nodes.inspectTabs.handlers.click();
  assert.equal(f.nodes.choosePreparationTab.disabled, true);
  assert.match(f.nodes.tabNextReason.textContent, /탭 확인에 실패/);
  assert.equal(vm.runInContext('tabDiagnosticText', f.context), 'inspection unavailable');
});

test('failed tab opening preserves controller connection guidance', async () => {
  const f = fixture();
  await f.show(readyTab, false);
  f.setOpen(() => ({ ok: false, error: 'tab moved' }));
  await f.nodes.openDiagnosticTab.handlers.click();
  assert.match(f.nodes.tabNextReason.textContent, /컨트롤러에 연결/);
  assert.equal(vm.runInContext('tabDiagnosticText', f.context), 'tab moved');

  await f.show();
  let finish;
  f.setOpen(() => new Promise(resolve => { finish = resolve; }));
  const opening = f.nodes.choosePreparationTab.handlers.click();
  f.setStateResponse({ ok: true, state: { connected: false, extensionVersion: '1.2.3' } });
  await vm.runInContext('refresh()', f.context);
  finish({ ok: false, error: 'open failed after disconnect' });
  await opening;
  assert.equal(f.nodes.choosePreparationTab.disabled, true);
  assert.match(f.nodes.tabNextReason.textContent, /컨트롤러에 연결/);
});
