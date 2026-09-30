import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { Server, utils } from 'ssh2';
import { sshService, fingerprintHostKey } from '../src/services/sshService';
import { SSHError } from '../src/utils/errors';
import { SSHConfig } from '../src/types';

describe('SSH host key pinning', () => {
  const hostKey = utils.generateKeyPairSync('ed25519');
  let server: Server;
  let port: number;
  let expectedFingerprint: string;

  before(async () => {
    const parsed = utils.parseKey(hostKey.private);
    if (parsed instanceof Error) throw parsed;
    expectedFingerprint = fingerprintHostKey(parsed.getPublicSSH());

    server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === 'secret') ctx.accept();
        else ctx.reject(['password']);
      });
      client.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const config = (overrides: Partial<SSHConfig> = {}): SSHConfig => ({
    host: '127.0.0.1',
    port,
    username: 'tester',
    password: 'secret',
    ...overrides,
  });

  test('reports the host key on first connection so it can be pinned', async () => {
    let seen: string | null = null;
    const client = await sshService.createConnection(config({ onHostKeyFirstSeen: (fp) => { seen = fp; } }));
    client.end();

    assert.equal(seen, expectedFingerprint);
    assert.match(expectedFingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  test('connects when the pinned key matches', async () => {
    let called = false;
    const client = await sshService.createConnection(
      config({ hostKeyFingerprint: expectedFingerprint, onHostKeyFirstSeen: () => { called = true; } })
    );
    client.end();

    assert.equal(called, false);
  });

  test('refuses a server whose key differs from the pinned one', async () => {
    await assert.rejects(
      sshService.createConnection(config({ hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) })),
      (error: unknown) =>
        error instanceof SSHError && error.code === 'SSH_HOST_KEY_MISMATCH' && error.message.includes(expectedFingerprint)
    );
  });
});
