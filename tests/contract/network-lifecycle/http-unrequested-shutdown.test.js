import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { createBridgeServer } from '../../../src/server.js';
import { loadConfig } from '../../../src/config.js';
import { productionProcess } from '../../../scripts/e2e/helpers/process.mjs';
import { resources } from '../../../scripts/e2e/helpers/resources.mjs';
import { bounded } from '../../../scripts/e2e/helpers/deadline.mjs';
import { readHttpHeaders } from '../../helpers/socket-headers.mjs';

function journal() {
  const events = [], changed = new EventEmitter();
  return {
    events,
    sink(event) { events.push(event); changed.emit('event', event); },
    async wait(matches) {
      const found = events.find(matches);
      if (found) return found;
      let listener;
      try {
        return await bounded(new Promise(resolve => {
          listener = event => { if (matches(event)) resolve(event); };
          changed.on('event', listener);
        }), 3000);
      } finally { changed.off('event', listener); }
    },
  };
}

async function fixture(t, { diagnostics = true } = {}) {
  const owner = resources(t), log = journal();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-unrequested-http-'));
  owner.add('contract workspace', () => fs.rmSync(root, {recursive:true,force:true}), 30);
  const runtimeConfig = {...loadConfig({cwd:root,env:{WORKSPACE:root,DEMO_MODE:'false'}}),port:0};
  const bridge = createBridgeServer({runtimeConfig,onDiagnostic:diagnostics ? log.sink : undefined});
  owner.add('contract bridge', () => bridge.close(), 20);
  await bridge.listen();
  return {owner,bridge,log,port:bridge.server.address().port};
}

async function connect(owner, server, port) {
  const accepted = once(server, 'connection');
  const client = net.createConnection({host:'127.0.0.1',port,allowHalfOpen:true});
  owner.add('contract TCP client', () => client.destroy(), 0);
  client.on('error', () => {});
  const connected = once(client, 'connect');
  const [peer] = await accepted;
  await connected;
  return {client,peer};
}

test('NetworkLifecycle / unrequested TCP: IPC shutdown closes a silent accepted connection and the process exits naturally', {timeout:15000}, async t => {
  const owner = resources(t), server = await productionProcess({configured:true});
  owner.add('production bridge', () => server.dispose(), 20);
  await server.ready();
  const url = new URL(server.baseUrl);
  const client = net.createConnection({host:url.hostname,port:Number(url.port),allowHalfOpen:true});
  owner.add('contract TCP client', () => client.destroy(), 0);
  client.on('error', () => {});
  client.resume();
  await once(client, 'connect');
  // A second real HTTP probe completes before shutdown; the silent TCP client
  // stays open throughout the production process exit observation.
  await server.ready();
  const result = await server.stop(), logs = server.logs();
  const events = logs.stderr.split('\n').filter(line => line.startsWith('[bridge.shutdown] '))
    .map(line => JSON.parse(line.slice('[bridge.shutdown] '.length)));
  const start = events.find(event => event.type === 'shutdown.http.inventory' && event.phase === 'shutdown-start');
  assert.ok(start?.socketDetails.some(socket => socket.requestCount === 0 && socket.upgrade === null
    && socket.bytesRead === 0 && socket.bytesWritten === 0 && !socket.destroyed), 'the production server must own the silent connection before stop');
  assert.deepEqual(result, {code:0,signal:null,forced:false}, JSON.stringify(logs));
  assert.ok(events.some(event => event.type === 'shutdown.stage.done' && event.stage === 'HTTP server close'));
  assert.equal(events.some(event => event.type === 'shutdown.deadline'), false);
});

test('NetworkLifecycle / unrequested TCP: connection cleanup works without a diagnostic sink', {timeout:7000}, async t => {
  const {owner,bridge,port} = await fixture(t, {diagnostics:false});
  const {client,peer} = await connect(owner, bridge.server, port);
  client.resume();
  assert.equal(peer.bytesRead, 0);
  assert.equal(peer.destroyed, false);
  await bounded(bridge.close(), 3000);
  assert.equal(peer.destroyed, true);
});

test('NetworkLifecycle / unrequested TCP: shutdown preserves a partially received HTTP header until the request completes', {timeout:7000}, async t => {
  const {owner,bridge,log,port} = await fixture(t);
  const {client,peer} = await connect(owner, bridge.server, port);
  const headers = readHttpHeaders(client), received = once(peer, 'data');
  client.write(`GET /api/preflight HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
  await received;
  assert.ok(peer.bytesRead > 0);
  assert.equal(log.events.some(event => event.type === 'request.received'), false);
  let finished = false;
  const closed = bridge.close().then(() => { finished = true; });
  await log.wait(event => event.type === 'shutdown.http.inventory' && event.phase === 'http-close-start');
  assert.equal(finished, false);
  assert.equal(peer.destroyed, false, 'received HTTP bytes must not be treated as a silent connection');
  client.write('Connection: close\r\n\r\n');
  assert.match((await headers).toString('latin1'), /^HTTP\/1\.1 200 /u);
  await bounded(closed, 3000);
});

test('NetworkLifecycle / unrequested TCP: shutdown drains an active HTTP request instead of discarding its unfinished body', {timeout:7000}, async t => {
  const {owner,bridge,log,port} = await fixture(t);
  const {client,peer} = await connect(owner, bridge.server, port);
  const body = '{"hold":true}', headers = readHttpHeaders(client);
  client.write(`GET /api/preflight HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0,1)}`);
  const request = await log.wait(event => event.type === 'request.received');
  let finished = false;
  const closed = bridge.close().then(() => { finished = true; });
  await log.wait(event => event.type === 'shutdown.http.inventory' && event.phase === 'http-close-start');
  assert.equal(finished, false);
  assert.equal(peer.destroyed, false, 'an active request must retain its TCP connection');
  client.write(body.slice(1));
  assert.match((await headers).toString('latin1'), /^HTTP\/1\.1 200 /u);
  await bounded(closed, 3000);
  assert.ok(log.events.some(event => event.type === 'request.completed' && event.requestId === request.requestId && event.status === 200));
});
