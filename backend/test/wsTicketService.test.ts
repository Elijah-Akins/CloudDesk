import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WsTicketService } from '../src/services/wsTicketService';

describe('WsTicketService', () => {
  test('a ticket opens its session once', () => {
    const service = new WsTicketService();
    const { ticket } = service.issue('user-1', 'session-1');

    assert.equal(service.redeem(ticket, 'session-1'), 'user-1');
    assert.equal(service.redeem(ticket, 'session-1'), null);
  });

  test('a ticket is useless for another session, and is spent by the attempt', () => {
    const service = new WsTicketService();
    const { ticket } = service.issue('user-1', 'session-1');

    assert.equal(service.redeem(ticket, 'session-2'), null);
    assert.equal(service.redeem(ticket, 'session-1'), null);
  });

  test('tickets expire after 30 seconds', () => {
    let now = 1_000_000;
    const service = new WsTicketService(() => now);
    const { ticket, expiresInMs } = service.issue('user-1', 'session-1');

    assert.equal(expiresInMs, 30000);
    now += 30001;
    assert.equal(service.redeem(ticket, 'session-1'), null);
  });

  test('unknown tickets are rejected, and tickets are unguessable', () => {
    const service = new WsTicketService();
    const { ticket } = service.issue('user-1', 'session-1');

    assert.equal(service.redeem('made-up', 'session-1'), null);
    assert.ok(ticket.length >= 43);
    assert.notEqual(service.issue('user-1', 'session-1').ticket, ticket);
  });
});
