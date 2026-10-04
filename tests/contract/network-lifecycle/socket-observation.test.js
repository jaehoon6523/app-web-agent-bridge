import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBridgeServer } from '../../../src/server.js';
import { loadConfig } from '../../../src/config.js';
import { createServerObserver } from '../../../src/diagnostics/server-observer.js';
import { resources } from '../../../scripts/e2e/helpers/resources.mjs';
import { bounded } from '../../../scripts/e2e/helpers/deadline.mjs';
import { readHttpHeaders } from '../../helpers/socket-headers.mjs';

function eventLog() {
  const events = [], waiters = [];
  return { events,
    sink(event) {
      events.push(event);
      for (const waiter of waiters) if (waiter.matches(event)) waiter.resolve(event);
    },
    wait(matches) {
      const found = events.find(matches);
      return found ? Promise.resolve(found) : bounded(new Promise(resolve => waiters.push({matches,resolve})), 3000);
    },
  };
}

async function fixture(t, options = {}) {
  const owner = resources(t), log = eventLog();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-socket-observation-'));
  owner.add('contract workspace', () => fs.rmSync(root, {recursive:true,force:true}), 30);
  const runtimeConfig = {...loadConfig({cwd:root,env:{WORKSPACE:root,DEMO_MODE:'false',
    WEB_EXTENSION_SHARED_SECRET:'contract-secret-never-in-socket-events',
    WEB_EXTENSION_EXPECTED_IDENTITY:'contract-extension'}}),port:0};
  const bridge = createBridgeServer({runtimeConfig,onDiagnostic:log.sink,...options});
  owner.add('contract bridge', () => bridge.close(), 20);
  await bridge.listen();
  return {owner,bridge,log,port:bridge.server.address().port};
}

test('NetworkLifecycle observation: a pre-request TCP connection becomes a correlated real HTTP request', {timeout:5000}, async t => {
  const {owner,bridge,log,port} = await fixture(t);
  const client = net.createConnection({host:'127.0.0.1',port});
  owner.add('contract TCP client', () => client.destroy(), 0);
  const closed = new Promise(resolve => client.once('close', resolve));
  client.on('error', () => {});
  await once(client, 'connect');
  const accepted = await log.wait(event => event.type === 'connection.accepted');
  const initial = bridge.socketInventory('contract-before-request').socketDetails.find(socket => socket.socketId === accepted.socketId);
  assert.equal(initial.owner, 'http-server-unclassified');
  assert.equal(initial.requestCount, 0);
  assert.deepEqual(initial.activeRequests, []);
  assert.equal(initial.upgrade, null);
  assert.equal(initial.destroyed, false);
  assert.equal(initial.localPort, port);
  assert.equal(initial.remotePort, client.localPort);
  const headers = readHttpHeaders(client);
  client.write(`GET /api/preflight?private=query-secret HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer header-secret\r\nConnection: close\r\n\r\n`);
  assert.match((await headers).toString('latin1'), /^HTTP\/1\.1 200 /u);
  await closed;
  await log.wait(event => event.type === 'connection.closed' && event.socketId === accepted.socketId);
  const received = log.events.find(event => event.type === 'request.received');
  assert.equal(received.socketId, accepted.socketId);
  assert.equal(received.route, '/api/preflight');
  const completed = log.events.find(event => event.type === 'request.completed' && event.requestId === received.requestId);
  assert.equal(completed.socketId, accepted.socketId);
  assert.equal(completed.status, 200);
  assert.equal(bridge.socketInventory('contract-after-close').sockets, 0);
  assert.doesNotMatch(JSON.stringify(log.events), /query-secret|header-secret|contract-secret/u);
});

test('NetworkLifecycle observation: keep-alive reuse and an unfinished response retain request ownership without payloads', {timeout:5000}, async t => {
  const owner = resources(t), log = eventLog(), observer = createServerObserver(log.sink);
  let pending;
  const server = http.createServer((req, res) => {
    if (req.url === '/warm') { res.end('warm'); return; }
    req.on('end', () => { pending = res; res.writeHead(200); res.write('controlled response'); });
    req.resume();
  });
  server.on('connection', observer.connected);
  server.prependListener('request', observer.received);
  owner.add('contract HTTP server', () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 20);
  owner.add('contract unfinished response', () => pending?.end(), 0);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = new http.Agent({keepAlive:true,maxSockets:1});
  owner.add('contract HTTP client', () => agent.destroy(), 0);
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    http.get({host:'127.0.0.1',port,path:'/warm',agent}, response => {
      response.resume(); response.once('end', resolve);
    }).once('error', reject);
  });
  const response = await new Promise((resolve, reject) => {
    const request = http.request({host:'127.0.0.1',port,path:'/api/commands?private=query-secret',method:'POST',agent,
      headers:{authorization:'Bearer header-secret'}}, resolve);
    request.once('error', reject);
    request.end('body-secret');
  });
  response.resume();
  observer.beginShutdown();
  const inventory = observer.socketInventory('contract-pending-response');
  assert.equal(inventory.sockets, 1);
  const socket = inventory.socketDetails[0];
  assert.equal(socket.owner, 'http-server');
  assert.equal(socket.requestCount, 2);
  assert.equal(socket.activeRequests.length, 1);
  assert.equal(socket.activeRequests[0].route, '/api/commands');
  assert.equal(socket.activeRequests[0].requestComplete, true);
  assert.equal(socket.activeRequests[0].headersSent, true);
  assert.equal(socket.activeRequests[0].responseWritableEnded, false);
  assert.equal(socket.activeRequests[0].responseWritableFinished, false);
  assert.equal(new Set(log.events.filter(event => event.type === 'request.received').map(event => event.socketId)).size, 1);
  assert.doesNotMatch(JSON.stringify({inventory,events:log.events}), /query-secret|header-secret|body-secret/u);
  const ended = once(response, 'end');
  pending.end();
  await ended;
  await log.wait(event => event.type === 'request.completed' && event.route === '/api/commands');
  assert.equal(observer.socketInventory('contract-response-finished').socketDetails[0].activeRequests.length, 0);
});

test('NetworkLifecycle observation: accepted production WebSocket ownership and TCP closure share one socket ID', {timeout:5000}, async t => {
  const {owner,bridge,log,port} = await fixture(t);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws/extension`);
  client.on('error', () => {});
  owner.add('contract WebSocket peer', () => client.terminate(), 0);
  await once(client, 'open');
  const socket = bridge.socketInventory('contract-upgraded').socketDetails[0];
  assert.equal(socket.owner, 'extension-websocket');
  assert.deepEqual(socket.upgrade, {route:'/ws/extension',outcome:'ACCEPTED',status:101});
  assert.equal(socket.webSocketState, 'OPEN');
  assert.equal(socket.requestCount, 0);
  const closed = new Promise(resolve => client.once('close', resolve));
  await bridge.close();
  await closed;
  await log.wait(event => event.type === 'shutdown.socket.event' && event.event === 'close' && event.socketId === socket.socketId);
  assert.ok(log.events.some(event => event.type === 'shutdown.http.inventory' && event.phase === 'shutdown-start'
    && event.socketDetails.some(detail => detail.socketId === socket.socketId && detail.webSocketState === 'OPEN')));
  assert.ok(log.events.some(event => event.type === 'shutdown.websocket.close.callback' && event.errorCode === null));
  assert.ok(log.events.some(event => event.type === 'shutdown.http.close.callback' && event.errorCode === null));
  assert.equal(bridge.server.listening, false);
  assert.doesNotMatch(JSON.stringify(log.events), /contract-secret|Sec-WebSocket|sharedSecret/u);
});

test('NetworkLifecycle observation: an upgrade during shutdown is identified as rejected without becoming a WebSocket owner', {timeout:5000}, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {owner,bridge,log,port} = await fixture(t, {createLiveRuntime:async () => ({close:() => gate})});
  owner.add('contract runtime gate', () => release(), 0);
  await bridge.getLiveRuntime();
  const closing = bridge.close();
  await log.wait(event => event.type === 'shutdown.stage.start' && event.stage === 'runtime.close');
  const client = net.createConnection({host:'127.0.0.1',port});
  client.on('error', () => {});
  owner.add('contract rejected peer', () => client.destroy(), 0);
  const closed = new Promise(resolve => client.once('close', resolve));
  await once(client, 'connect');
  client.write(`GET /ws/extension?private=query-secret HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const rejected = await log.wait(event => event.type === 'shutdown.socket.event' && event.event === 'upgrade.rejected');
  assert.equal(rejected.acceptedDuringShutdown, true);
  assert.equal(rejected.owner, 'http-upgrade');
  assert.deepEqual(rejected.upgrade, {route:'/ws/extension',outcome:'REJECTED',status:503});
  assert.equal(rejected.webSocketState, null);
  assert.equal(rejected.requestCount, 0);
  // Preserve the current rejection behavior, including possible TCP resets.
  client.resume();
  await closed;
  await log.wait(event => event.type === 'connection.closed' && event.socketId === rejected.socketId);
  release();
  await closing;
  assert.doesNotMatch(JSON.stringify(log.events), /query-secret|contract-secret|dGhlIHNh/u);
});

test('NetworkLifecycle observation: diagnostic error monitoring neither handles errors nor consumes TCP data', {timeout:5000}, async t => {
  const owner = resources(t), events = [], observer = createServerObserver(event => { events.push(event); throw new Error('sink failure'); });
  const server = net.createServer();
  owner.add('contract TCP server', () => new Promise(resolve => server.close(resolve)), 20);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = net.createConnection({host:'127.0.0.1',port:server.address().port});
  owner.add('contract TCP client', () => client.destroy(), 0);
  const [peer] = await accepted;
  owner.add('contract TCP peer', () => peer.destroy(), 0);
  const errorHandlers = peer.listenerCount('error'), dataHandlers = peer.listenerCount('data');
  observer.connected(peer);
  observer.connected(peer);
  assert.equal(observer.socketInventory('contract').sockets, 1);
  assert.equal(peer.listenerCount('error'), errorHandlers);
  assert.equal(peer.listenerCount('data'), dataHandlers);
  const cause = Object.assign(new Error('private-error-payload'), {code:'CONTROLLED_SOCKET_ERROR'});
  assert.throws(() => peer.emit('error', cause), error => error === cause);
  observer.beginShutdown();
  const inventory = observer.socketInventory('contract-error');
  assert.ok(inventory.socketDetails[0].history.some(event => event.event === 'error' && event.errorCode === 'CONTROLLED_SOCKET_ERROR'));
  assert.doesNotMatch(JSON.stringify({inventory,events}), /private-error-payload|sink failure/u);
  const data = once(client, 'data');
  peer.write('unchanged TCP bytes');
  assert.equal((await data)[0].toString(), 'unchanged TCP bytes');
});
