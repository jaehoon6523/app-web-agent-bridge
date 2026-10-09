import { readFile, stat } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { ChatGptWebSessionAdapter, WebExtensionTransport, WebSessionAdapter } from '../../src/runtime/web/index.js';

const extensionRoot = new URL('../../extension/', import.meta.url);
const publicRoot = new URL('../../public/', import.meta.url);
const publicRootPath = fileURLToPath(publicRoot);
const secret = 'browser-fixture-only-0123456789abcdef';
const identity = 'browser-fixture-extension';

function dashboardFixtureAsset(pathname) {
  let asset;
  try {
    asset = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  if (!asset || asset.includes('\0')) return null;
  const resolved = path.resolve(publicRootPath, asset);
  const relative = path.relative(publicRootPath, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const extension = path.extname(resolved).toLowerCase();
  const contentType = extension === '.js' ? 'text/javascript'
    : extension === '.css' ? 'text/css'
      : extension === '.html' ? 'text/html' : null;
  return contentType ? { resolved, contentType } : null;
}

// Real production modules, HMAC, WebSocket and DOM. Only Chrome APIs and the
// provider page are fixtures; this is not evidence of live ChatGPT behavior.
export async function extensionBrowser(t, {
  navigation = 'spa',
  variant = 'roles',
  initialUrl = 'https://chatgpt.com/',
  reply = () => 'Observed fixture reply',
  providerHtml = null,
  production = null,
  autoConnect = true,
  cleanup = null,
} = {}) {
  const browser = await chromium.launch({
    ...(process.env.UI_BROWSER_EXECUTABLE ? { executablePath: process.env.UI_BROWSER_EXECUTABLE }
      : { channel: process.env.UI_BROWSER_CHANNEL || 'chrome' }), headless: true,
    // Routed fixture documents have no network address space. This applies only
    // to this disposable browser; production HTTP remains real when configured.
    args: ['--disable-features=LocalNetworkAccessChecks'],
  });
  const after = dispose => cleanup ? cleanup.add('extension browser resource', dispose) : t.after(dispose);
  after(() => browser.close());
  const context = await browser.newContext();
  const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'));
  const scripts = await Promise.all(manifest.content_scripts[0].js.map(file => readFile(new URL(file, extensionRoot), 'utf8')));
  const transport = production ? null : new WebExtensionTransport({ sharedSecret: secret, expectedExtensionIdentity: identity });
  const server = production ? null : new WebSocketServer({ host: '127.0.0.1', port: 0 });
  if (server) await once(server, 'listening');
  const frames = [];
  server?.on('connection', socket => {
    socket.on('message', raw => frames.push(JSON.parse(String(raw))));
    transport.attach(socket);
  });
  const createAdapter = provider => {
    if (production) throw new Error('Production transport is owned by src/server.js');
    return provider === 'CHATGPT_WEB'
    ? new ChatGptWebSessionAdapter({ transport, responseTimeoutMs: 8_000 })
    : new WebSessionAdapter({ transport, provider, responseTimeoutMs: 8_000 });
  };
  const adapter = production ? null : createAdapter('CHATGPT_WEB');
  after(async () => {
    if (!server) return;
    await adapter.close(); transport.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  let stored = { controllerUrl: production ? production.baseUrl.replace(/^http/, 'ws') + '/ws/extension' : `ws://127.0.0.1:${server.address().port}/ws/extension`,
    sharedSecret: production?.sharedSecret ?? secret, extensionIdentity: production?.extensionIdentity ?? identity };
  const page = await context.newPage();
  const background = await context.newPage();
  if (production) background.on('websocket', socket => {
    for (const event of ['framesent', 'framereceived']) socket.on(event, frame => {
      const message = JSON.parse(String(frame.payload));
      frames.push({ direction:event, type:message.type, requestId:message.requestId ?? null });
    });
  });
  const pages = new Map([[7, page]]);
  const unavailableTabs = new Set();
  let nextTabId = 8;
  const errors = [];
  const diagnostics = [];
  background.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  background.on('requestfailed', request => diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`));
  background.on('pageerror', error => errors.push(error.message));
  const sendContent = (message, target = page) => target.evaluate(message => new Promise(resolve => {
    const asyncReply = globalThis.fixtureContentListener(message, {}, resolve);
    if (!asyncReply && message.type !== 'agent.ping' && message.type !== 'agent.cancel') resolve(null);
  }), message);
  await background.exposeBinding('fixtureStorage', (_source, operation, value) => {
    if (operation === 'set') stored = { ...stored, ...structuredClone(value) };
    return structuredClone(stored);
  });
  const tab = id => ({ id, windowId: 3, url: pages.get(id).url(), title: 'Provider DOM fixture' });
  const commands = [];
  const contentResults = [];
  await background.exposeBinding('fixtureTabs', async (_source, operation, value) => {
    if (operation === 'query') return [...pages.keys()].map(tab);
    if (operation === 'get') return pages.has(value) ? tab(value) : null;
    if (operation === 'update') return tab(value.id);
    if (operation === 'create') {
      const id = nextTabId++;
      const created = await context.newPage();
      pages.set(id, created);
      await configureProviderPage(created, id);
      await created.goto(value.url);
      return tab(id);
    }
    if (operation === 'sendMessage') {
      commands.push(value.message);
      const target = pages.get(value.id);
      if (!target) throw new Error(`Unknown fixture tab: ${value.id}`);
      const result = await sendContent(value.message, target);
      contentResults.push({ request: structuredClone(value.message), result: structuredClone(result) });
      return result;
    }
    throw new Error(`Unexpected Chrome operation: ${operation}`);
  });
  await background.addInitScript(({ manifest }) => {
    const event = () => ({ addListener() {} });
    globalThis.chrome = {
      storage: { local: { get: () => fixtureStorage('get'), set: value => fixtureStorage('set', value) } },
      runtime: { getManifest: () => manifest, sendMessage: async message => { globalThis.fixturePopupState = message.payload; },
        onMessage: { addListener(listener) { globalThis.fixtureBackgroundListener = listener; } } },
      tabs: { query: () => fixtureTabs('query'), get: id => fixtureTabs('get', id),
        update: (id, options) => fixtureTabs('update', { id, options }),
        create: options => fixtureTabs('create', options),
        sendMessage: (id, message) => fixtureTabs('sendMessage', { id, message }),
        onActivated: event(), onCreated: event(), onRemoved: event(), onUpdated: event() },
      windows: { update: async () => {} },
      scripting: { executeScript: async () => { throw new Error('Fixture content script is not ready'); } },
    };
  }, { manifest });
  async function configureProviderPage(providerPage, id) {
    providerPage.on('pageerror', error => errors.push(error.message));
    await providerPage.exposeBinding('fixtureProgress', (_source, message) => background.evaluate(({ message, id }) => {
      globalThis.fixtureBackgroundListener?.(message, { tab: { id }, frameId: 0 }, () => {});
    }, { message, id }));
    await providerPage.exposeBinding('fixtureReply', (_source, text) => reply(text, { page:providerPage, tabId:id }));
    await providerPage.addInitScript(({ id, production }) => {
      globalThis.fixtureConversationId = production && id !== 7 ? 'created-' + id : 'created';
      globalThis.chrome = { runtime: {
        getManifest: () => ({ version: 'fixture-content-version' }),
        onMessage: { addListener(listener) { globalThis.fixtureContentRegistrations = (globalThis.fixtureContentRegistrations || 0) + 1;
          globalThis.fixtureContentListener = listener; } },
        sendMessage: message => fixtureProgress(message),
      } };
    }, { id, production:Boolean(production) });
  }
  await configureProviderPage(page, 7);
  let dashboardSnapshot = null;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'dashboard.fixture') {
      if (production) throw new Error('Fixture Dashboard API is forbidden in production mode');
      if (url.pathname === '/api/dashboard/session') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ token: 'fixture-dashboard-token' }) });
      }
      if (url.pathname === '/api/state') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(dashboardSnapshot) });
      }
      const asset = dashboardFixtureAsset(url.pathname);
      if (!asset) return route.abort();
      const info = await stat(asset.resolved).catch(() => null);
      if (!info?.isFile()) return route.abort();
      return route.fulfill({ contentType: asset.contentType, body: await readFile(asset.resolved, 'utf8') });
    }
    if (url.hostname === '127.0.0.1') {
      if (url.pathname === (production ? '/__bridge_e2e__/background.html' : '/')) return route.fulfill({ contentType: 'text/html', body: '<script type="module" src="/extension/background.js"></script>' });
      if (production && !url.pathname.startsWith('/extension/')) return route.continue();
      if (!/^\/extension\/[a-z0-9/.-]+\.js$/i.test(url.pathname) || url.pathname.includes('..')) throw new Error('Invalid fixture module path');
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(url.pathname.slice('/extension/'.length), extensionRoot), 'utf8') });
    }
    if (url.hostname === 'chatgpt.com') {
      const tab = [...pages.entries()].find(([, value]) => value === route.request().frame().page());
      if (tab && unavailableTabs.has(tab[0])) return route.fulfill({ contentType:'text/html', body:'<main>Log in to ChatGPT</main>' + scripts.map(source => '<script>' + source.replaceAll('</script', '<\\/script') + '</script>').join('') });
      if (providerHtml !== null) {
        const injected = scripts.map(source => `<script>${source.replaceAll('</script', '<\\/script')}</script>`).join('');
        const body = providerHtml.includes('</body>')
          ? providerHtml.replace('</body>', `${injected}</body>`)
          : providerHtml + injected;
        return route.fulfill({ contentType: 'text/html', body });
      }
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Provider DOM fixture</title>
        <main id="messages"></main><textarea id="prompt-textarea"></textarea>
        <button data-testid="send-button">Send</button><script>
        const navigation = ${JSON.stringify(navigation)}, variant = ${JSON.stringify(variant)};
        const preserveHistory = ${JSON.stringify(Boolean(production))};
        function appendMessage(role, id, text, record = true) {
          const article = document.createElement('article'); article.id = id;
          if (variant === 'roles') article.setAttribute('data-message-author-role', role);
          else { article.setAttribute('data-testid', 'conversation-turn-' + id);
            if (variant === 'classes') article.className = role === 'user' ? 'group/user-turn' : 'group/agent-turn';
            else { const heading = document.createElement('h2'); heading.textContent = role === 'user' ? 'You said:' : 'ChatGPT said:'; article.append(heading); } }
          const body = document.createElement('div'); body.setAttribute('data-message-content', ''); body.style.whiteSpace = 'pre-wrap'; body.textContent = text;
          article.append(body); document.querySelector('#messages').append(article);
          if (preserveHistory && record) {
            const messages = JSON.parse(sessionStorage.getItem('fixtureMessages') || '[]');
            messages.push({ role, id, text }); sessionStorage.setItem('fixtureMessages', JSON.stringify(messages));
          }
        }
        window.appendFixtureMessage = appendMessage;
        const savedMessages = preserveHistory ? JSON.parse(sessionStorage.getItem('fixtureMessages') || '[]') : [];
        if (savedMessages.length) {
          for (const message of savedMessages) appendMessage(message.role, message.id, message.text, false);
        } else if (sessionStorage.getItem('submitted')) {
          appendMessage('user', 'u1', sessionStorage.getItem('submitted'));
          appendMessage('assistant', 'a1', 'Observed fixture reply');
        }
        document.querySelector('button').onclick = async () => {
          const composer = document.querySelector('textarea'), text = composer.value;
          sessionStorage.setItem('clicks', String(Number(sessionStorage.getItem('clicks') || 0) + 1));
          sessionStorage.setItem('submitted', text); composer.value = '';
          if (navigation === 'document') { location.href = '/uc/created'; return; }
          if (location.pathname === '/') {
            if (navigation === 'temporary-web') {
              history.pushState({}, '', '/c/WEB:temporary');
              sessionStorage.setItem('temporaryConversationUrl', location.href);
              await new Promise(resolve => setTimeout(resolve, 250));
            }
            history.pushState({}, '', '/c/' + globalThis.fixtureConversationId);
          }
          const sequence = sessionStorage.getItem('clicks');
          appendMessage('user', 'u' + sequence, text);
          const response = await window.fixtureReply(text);
          appendMessage('assistant', 'a' + sequence, response);
        };
        </script>${scripts.map(source => `<script>${source.replaceAll('</script', '<\\/script')}</script>`).join('')}` });
    }
    if (url.hostname === 'claude.ai') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Claude fixture</title>
        <main id="messages"></main>
        <div data-testid="chat-input" contenteditable="true" role="textbox" style="width:320px;height:40px"></div>
        <button data-testid="chat-input-send">Send</button><script>
        function appendClaudeMessage(role, id, text) {
          const article = document.createElement('article'); article.setAttribute('data-message-id', id);
          const body = document.createElement('div');
          if (role === 'user') body.setAttribute('data-testid', 'user-message');
          else { body.setAttribute('data-testid', 'chat-message-content'); body.className = 'font-claude-response'; }
          const content = document.createElement('div'); content.className = 'standard-markdown'; content.style.whiteSpace = 'pre-wrap'; content.textContent = text;
          body.append(content); article.append(body); document.querySelector('#messages').append(article);
        }
        if (sessionStorage.getItem('submitted')) {
          appendClaudeMessage('user', 'cu1', sessionStorage.getItem('submitted'));
          appendClaudeMessage('assistant', 'ca1', 'Observed fixture reply');
        }
        document.querySelector('[data-testid="chat-input-send"]').onclick = async () => {
          const composer = document.querySelector('[data-testid="chat-input"]');
          const text = composer.innerText || composer.textContent || '';
          sessionStorage.setItem('clicks', String(Number(sessionStorage.getItem('clicks') || 0) + 1));
          sessionStorage.setItem('submitted', text); composer.textContent = '';
          if (location.pathname === '/new') history.pushState({}, '', '/chat/created');
          const sequence = sessionStorage.getItem('clicks');
          appendClaudeMessage('user', 'cu' + sequence, text);
          const response = await window.fixtureReply(text);
          appendClaudeMessage('assistant', 'ca' + sequence, response);
        };
        </script>${scripts.map(source => `<script>${source.replaceAll('</script', '<\\/script')}</script>`).join('')}` });
    }
    return route.abort();
  });
  await page.goto(initialUrl);
  async function connect() {
    const authenticated = production ? null : once(transport, 'authenticated', { signal: AbortSignal.timeout(5_000) });
    await background.goto(production ? `${production.baseUrl}/__bridge_e2e__/background.html` : `http://127.0.0.1:${server.address().port}/`);
    await (production ? production.waitAuthenticated() : authenticated).catch(async error => {
      const lastError = await background.evaluate(() => globalThis.fixturePopupState?.lastError);
      throw new Error(`Extension authentication failed: ${lastError}; ${errors.join('; ')}; ${diagnostics.join('; ')}; ${error.message}`);
    });
  }
  if (autoConnect) await connect();
  return { connect, adapter, createAdapter, transport, page, background, frames, commands, contentResults, errors, sendContent,
    readStorage: () => structuredClone(stored),
    providerPages: () => [...pages.entries()],
    setProviderUnavailable: (id, value) => value ? unavailableTabs.add(id) : unavailableTabs.delete(id),
    createProviderTab: url => background.evaluate(url => chrome.tabs.create({ url }), url),
    async openDashboard(snapshot) {
      if (production) throw new Error('Use the actual production Dashboard browser');
      dashboardSnapshot = structuredClone(snapshot);
      const dashboard = await context.newPage();
      const loadFailure = new Promise((_, reject) => {
        dashboard.on('pageerror', error => {
          errors.push(error.message);
          reject(new Error(`Dashboard fixture page error: ${error.message}`));
        });
        dashboard.on('requestfailed', request => {
          const requestUrl = new URL(request.url());
          if (requestUrl.hostname !== 'dashboard.fixture'
            || !['document', 'script', 'stylesheet'].includes(request.resourceType())) return;
          const detail = `${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`;
          diagnostics.push(detail);
          reject(new Error(`Dashboard fixture asset failed: ${detail}`));
        });
      });
      const dashboardReady = (async () => {
        await dashboard.goto('https://dashboard.fixture/');
        await dashboard.locator('#projectPanel').waitFor({ state: 'visible' });
      })();
      await Promise.race([dashboardReady, loadFailure]);
      return dashboard;
    },
    async prepare(runId = 'r1') {
      if (production) throw new Error('Use the production Dashboard preparation action');
      await adapter.resume({ binding: { sessionId: 's1', runId, tabId: null, windowId: null,
        documentId: null, frameId: null, conversationUrl: null, conversationId: null,
        title: null, lastObservedUserMessageId: null, lastObservedAssistantMessageId: null, bindingStatus: 'NEEDS_REBIND' } });
    },
    async submit(turnId = 'd1') {
      if (production) throw new Error('Use the production Dashboard submission action');
      const handle = await adapter.submitTurn({ turnId, controllerMessageId: turnId, runId: 'r1', text: 'Read this controlled prompt',
        timeoutMs: 8_000, stableMs: 1_000, parseResponse: raw => ({ body: raw, packetText: raw, packet: { type: 'FIXTURE_REPLY' } }) });
      return handle.completion;
    },
  };
}
