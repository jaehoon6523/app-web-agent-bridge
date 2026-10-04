import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { readHttpHeaders } from '../../helpers/socket-headers.mjs';
import { resources } from '../../../scripts/e2e/helpers/resources.mjs';

async function sockets(t) {
  const owner = resources(t), server = net.createServer();
  owner.add('TCP server', () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 20);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = net.createConnection({ host:'127.0.0.1', port:server.address().port });
  client.on('error', () => {});
  owner.add('TCP client', () => client.destroy(), 10);
  const connected = once(client, 'connect');
  const [peer] = await accepted;
  peer.on('error', () => {});
  owner.add('TCP peer', () => peer.destroy(), 10);
  await connected;
  return { client, peer };
}

test('NetworkLifecycle headers: fragmented status and header terminator complete before upgrade observation', {timeout:5000}, async t => {
  const { client, peer } = await sockets(t);
  let settled = false;
  const response = readHttpHeaders(client).then(headers => { settled = true; return headers; });
  // Each receive acknowledges a fragment before the next is sent. No assumption
  // about packet sizes, scheduling sleeps or a single data event is required.
  for (const fragment of ['HTTP/1.1 101 Swi', 'tching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n']) {
    const arrived = once(client, 'data');
    peer.write(fragment);
    await arrived;
    await Promise.resolve();
    assert.equal(settled, false);
  }
  peer.write('\r\nframe-bytes-after-header');
  assert.equal((await response).toString('latin1'), 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
});

test('NetworkLifecycle headers: incomplete peer EOF fails the observation', {timeout:5000}, async t => {
  const { client, peer } = await sockets(t);
  const rejected = assert.rejects(readHttpHeaders(client), { code:'HTTP_HEADERS_INCOMPLETE' });
  peer.end('HTTP/1.1 101 Switching Protocols\r\n');
  await rejected;
});

test('NetworkLifecycle headers: socket error preserves its cause', {timeout:5000}, async t => {
  const { client } = await sockets(t);
  const cause = new Error('controlled socket failure');
  const rejected = assert.rejects(readHttpHeaders(client), error => error === cause);
  client.destroy(cause);
  await rejected;
});

test('NetworkLifecycle headers: idle peer has a bounded deadline and releases observation listeners', {timeout:5000}, async t => {
  const { client } = await sockets(t);
  const events = ['data','error','end','close'];
  const counts = events.map(event => client.listenerCount(event));
  await assert.rejects(readHttpHeaders(client, {timeoutMs:50}), { code:'HTTP_HEADERS_DEADLINE' });
  assert.deepEqual(events.map(event => client.listenerCount(event)), counts);
});

test('NetworkLifecycle headers: oversized headers fail within the observation limit', {timeout:5000}, async t => {
  const { client, peer } = await sockets(t);
  const rejected = assert.rejects(readHttpHeaders(client, {maxBytes:32}), { code:'HTTP_HEADERS_TOO_LARGE' });
  peer.write(`HTTP/1.1 101 Switching Protocols\r\nX-Long: ${'x'.repeat(64)}\r\n\r\n`);
  await rejected;
});
