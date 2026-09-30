import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net, { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { SessionBridge, ViewerPermission } from '../src/websocket/SessionBridge';

/**
 * Exercises SessionBridge over real sockets: a fake VNC server stands in for the
 * SSH tunnel, and real WebSocket clients stand in for noVNC.
 */

const GREETING = Buffer.from('RFB 003.008\n', 'latin1');
const clientHandshake = (shared: number) =>
  Buffer.concat([Buffer.from('RFB 003.008\n', 'latin1'), Buffer.from([1]), Buffer.from([shared])]);
const keyEvent = (keysym: number) => {
  const b = Buffer.alloc(8);
  b[0] = 4;
  b[1] = 1;
  b.writeUInt32BE(keysym, 4);
  return b;
};
const fbUpdateRequest = () => Buffer.from([3, 1, 0, 0, 0, 0, 0, 100, 0, 100]);

interface FakeVncConnection {
  socket: net.Socket;
  received: Buffer;
  closed: boolean;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('SessionBridge', () => {
  const vncConnections: FakeVncConnection[] = [];
  let vncServer: net.Server;
  let httpServer: http.Server;
  let wss: WebSocketServer;
  let bridge: SessionBridge;
  let wsPort: number;

  before(async () => {
    vncServer = net.createServer((socket) => {
      const conn: FakeVncConnection = { socket, received: Buffer.alloc(0), closed: false };
      vncConnections.push(conn);
      socket.on('data', (data) => {
        conn.received = Buffer.concat([conn.received, data]);
      });
      socket.on('close', () => {
        conn.closed = true;
      });
      socket.write(GREETING);
    });
    await new Promise<void>((resolve) => vncServer.listen(0, '127.0.0.1', resolve));

    bridge = new SessionBridge({
      sessionId: 'session-1',
      tunnelHost: '127.0.0.1',
      tunnelPort: (vncServer.address() as AddressInfo).port,
      ownerId: 'owner',
    });

    httpServer = http.createServer();
    wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const userId = url.searchParams.get('user') || '';
      const permissions = (url.searchParams.get('perm') || 'view') as ViewerPermission;
      bridge.addViewer(userId, ws, permissions, userId === 'owner').catch(() => ws.close(1011));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    wsPort = (httpServer.address() as AddressInfo).port;
  });

  after(async () => {
    bridge.close();
    wss.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => vncServer.close(resolve));
  });

  const connectClient = async (user: string, perm: ViewerPermission = 'view') => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/?user=${user}&perm=${perm}`);
    const client = { ws, received: Buffer.alloc(0), closed: false, closeReason: '' };
    ws.on('message', (data: Buffer) => {
      client.received = Buffer.concat([client.received, data]);
    });
    ws.on('close', (_code, reason) => {
      client.closed = true;
      client.closeReason = reason.toString();
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return client;
  };

  test('gives each participant its own VNC connection and filters guest input', async () => {
    const owner = await connectClient('owner');
    await waitFor(() => vncConnections.length === 1, 'owner VNC connection');
    const guest = await connectClient('guest', 'view');
    await waitFor(() => vncConnections.length === 2, 'guest VNC connection');
    const [ownerVnc, guestVnc] = vncConnections;

    // Both get their own server greeting, i.e. their own RFB handshake
    await waitFor(() => owner.received.equals(GREETING) && guest.received.equals(GREETING), 'greetings');

    owner.ws.send(Buffer.concat([clientHandshake(1), keyEvent(0x61)]));
    guest.ws.send(Buffer.concat([clientHandshake(0), keyEvent(0x62), fbUpdateRequest()]));

    await waitFor(() => ownerVnc.received.length === 14 + 8, 'owner stream');
    await waitFor(() => guestVnc.received.length === 14 + 10, 'guest stream');

    assert.deepEqual(ownerVnc.received, Buffer.concat([clientHandshake(1), keyEvent(0x61)]));
    // Guest: shared flag forced on, key event dropped, view request kept
    assert.deepEqual(guestVnc.received, Buffer.concat([clientHandshake(1), fbUpdateRequest()]));

    // Granting control lets the guest's input through from the next message on
    assert.equal(bridge.updateViewerPermissions('guest', 'control'), true);
    guest.ws.send(keyEvent(0x63));
    await waitFor(() => guestVnc.received.length === 14 + 10 + 8, 'guest key event after grant');
    assert.deepEqual(guestVnc.received.subarray(24), keyEvent(0x63));

    // Kicking the guest closes only their connections
    assert.equal(bridge.kickViewer('guest'), true);
    await waitFor(() => guest.closed && guestVnc.closed, 'guest disconnect');
    assert.equal(owner.closed, false);
    assert.equal(ownerVnc.closed, false);
    assert.deepEqual(bridge.getViewerList().map((v) => v.userId), ['owner']);

    // The owner can't be kicked or downgraded
    assert.equal(bridge.kickViewer('owner'), false);
    assert.equal(bridge.updateViewerPermissions('owner', 'view'), false);

    owner.ws.send(fbUpdateRequest());
    await waitFor(() => ownerVnc.received.length === 14 + 8 + 10, 'owner still connected');

    owner.ws.close();
    await waitFor(() => ownerVnc.closed, 'owner VNC connection closed with its WebSocket');
    await waitFor(() => bridge.getViewerCount() === 0, 'bridge empty');
  });

  test('a reconnecting user replaces their previous connection', async () => {
    const before = vncConnections.length;
    const first = await connectClient('owner');
    await waitFor(() => vncConnections.length === before + 1, 'first connection');
    const second = await connectClient('owner');
    await waitFor(() => vncConnections.length === before + 2, 'second connection');

    await waitFor(() => first.closed && vncConnections[before].closed, 'old connection closed');
    assert.equal(first.closeReason, 'New connection established');
    assert.equal(second.closed, false);
    assert.equal(bridge.getViewerCount(), 1);

    bridge.close('Session ended');
    await waitFor(() => second.closed && vncConnections[before + 1].closed, 'bridge close');
    assert.equal(second.closeReason, 'Session ended');
  });
});
