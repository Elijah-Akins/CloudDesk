import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import {
  LicenseService,
  LicenseStateStore,
  StoredLicenseState,
  LicenseValidation,
} from '../src/services/licenseService';

const DAY = 24 * 60 * 60 * 1000;

const TEAM_VALIDATION: LicenseValidation = {
  valid: true,
  tier: 'team',
  expiresAt: null,
  limits: { maxUsers: -1, maxInstances: -1, maxConcurrentSessions: 20 },
  features: { sso: false, auditLogs: true, customBranding: true, prioritySupport: false, apiAccess: true, multiTenant: false },
  organization: 'Acme',
};

class MemoryStore implements LicenseStateStore {
  state: StoredLicenseState | null = null;
  async load() {
    return this.state ? { ...this.state } : null;
  }
  async save(state: StoredLicenseState) {
    this.state = { ...state };
  }
}

type Handler = (body: Record<string, unknown>, res: http.ServerResponse) => void;

describe('LicenseService', () => {
  let server: http.Server;
  let serverUrl: string;
  let unreachableUrl: string;
  let handler: Handler;
  let requests: Array<Record<string, unknown>>;

  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/api/licenses/validate');
        const body = JSON.parse(raw);
        requests.push(body);
        handler(body, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    // A port with nothing listening on it
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    unreachableUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((resolve) => closed.close(resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    requests = [];
    handler = (_body, res) => reply(res, 200, { success: true, data: TEAM_VALIDATION });
  });

  const makeService = (options: { key?: string; url?: string; store?: MemoryStore; now?: number }) =>
    new LicenseService({
      licenseKey: () => options.key ?? '',
      serverUrl: () => options.url ?? serverUrl,
      store: options.store ?? new MemoryStore(),
      now: () => options.now ?? Date.now(),
    });

  test('uses the Community tier without a key, without calling the license server', async () => {
    const service = makeService({});
    const license = await service.refresh();

    assert.equal(license.tier, 'community');
    assert.equal(license.valid, true);
    assert.equal(requests.length, 0);
    assert.equal(service.canAddUser(4), true);
    assert.equal(service.canAddUser(5), false);
  });

  test('applies the tier and limits the license server reports', async () => {
    const store = new MemoryStore();
    const service = makeService({ key: ' TEAM-AAAA-BBBB-CCCC-DDDD ', store });
    const license = await service.refresh();

    assert.equal(license.tier, 'team');
    assert.equal(license.valid, true);
    assert.equal(license.organization, 'Acme');
    assert.equal(service.canAddUser(10_000), true); // unlimited
    assert.equal(service.canStartSession(19), true);
    assert.equal(service.canStartSession(20), false);

    // The request identifies this deployment with a stable UUID
    assert.equal(requests[0].licenseKey, 'TEAM-AAAA-BBBB-CCCC-DDDD');
    assert.match(String(requests[0].instanceId), /^[0-9a-f-]{36}$/);
    assert.equal(store.state?.validation?.tier, 'team');

    await service.refresh();
    assert.equal(requests[1].instanceId, requests[0].instanceId);
  });

  test('falls back to Community when the license server rejects the key', async () => {
    const store = new MemoryStore();
    const service = makeService({ key: 'TEAM-AAAA-BBBB-CCCC-DDDD', store });
    await service.refresh();

    handler = (_body, res) =>
      reply(res, 400, { success: false, error: { message: 'License has been revoked', code: 'LICENSE_REVOKED' } });
    const license = await service.refresh();

    assert.equal(license.tier, 'community');
    assert.equal(license.valid, false);
    // Community limits apply rather than everything being blocked
    assert.equal(service.canAddUser(0), true);
    // A rejected key must not be resurrected from the cache later
    assert.equal(store.state?.validation, undefined);
  });

  test('keeps the last validation while the license server is unreachable, within the grace period', async () => {
    const store = new MemoryStore();
    const now = Date.now();
    await makeService({ key: 'TEAM-AAAA-BBBB-CCCC-DDDD', store, now }).refresh();

    const offline = makeService({ key: 'TEAM-AAAA-BBBB-CCCC-DDDD', store, url: unreachableUrl, now: now + 3 * DAY });
    const license = await offline.refresh();

    assert.equal(license.tier, 'team');
    assert.equal(license.valid, true);
  });

  test('treats rate limiting as a transient failure', async () => {
    const store = new MemoryStore();
    const service = makeService({ key: 'TEAM-AAAA-BBBB-CCCC-DDDD', store });
    await service.refresh();

    handler = (_body, res) =>
      reply(res, 429, { success: false, error: { message: 'Too many requests', code: 'RATE_LIMITED' } });

    assert.equal((await service.refresh()).tier, 'team');
  });

  test('stops trusting a cached validation after the grace period', async () => {
    const store = new MemoryStore();
    const now = Date.now();
    await makeService({ key: 'TEAM-AAAA-BBBB-CCCC-DDDD', store, now }).refresh();

    const offline = makeService({ key: 'TEAM-AAAA-BBBB-CCCC-DDDD', store, url: unreachableUrl, now: now + 15 * DAY });
    const license = await offline.refresh();

    assert.equal(license.tier, 'community');
    assert.equal(license.valid, false);
  });

  test('never applies a cached validation that belongs to a different key', async () => {
    const store = new MemoryStore();
    await makeService({ key: 'ENTERPRISE-AAAA-BBBB-CCCC-DDDD', store }).refresh();

    const offline = makeService({ key: 'ENTERPRISE-FORGED-KEY-0000-FFFF', store, url: unreachableUrl });

    assert.equal((await offline.refresh()).tier, 'community');
  });

  test('treats an expired license as Community', async () => {
    handler = (_body, res) =>
      reply(res, 200, {
        success: true,
        data: { ...TEAM_VALIDATION, expiresAt: new Date(Date.now() - DAY).toISOString() },
      });

    const license = await makeService({ key: 'TEAM-AAAA-BBBB-CCCC-DDDD' }).refresh();

    assert.equal(license.tier, 'community');
    assert.equal(license.valid, false);
  });

  test('ignores tiers it does not know about', async () => {
    handler = (_body, res) => reply(res, 200, { success: true, data: { ...TEAM_VALIDATION, tier: 'platinum' } });

    assert.equal((await makeService({ key: 'TEAM-AAAA-BBBB-CCCC-DDDD' }).refresh()).tier, 'community');
  });
});
