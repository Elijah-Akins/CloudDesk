import crypto from 'crypto';

/**
 * Short-lived, single-use tickets for opening the VNC WebSocket.
 *
 * Browsers can't set headers on a WebSocket, so whatever authenticates it ends
 * up in the URL, and from there in proxy access logs and browser history. A
 * ticket that works once, for one session, for a few seconds is harmless there;
 * the JWT is not.
 *
 * Tickets live in memory, like the tunnels they lead to (the API runs as a
 * single instance).
 */

const TICKET_TTL_MS = 30000;

interface TicketEntry {
  userId: string;
  sessionId: string;
  expiresAt: number;
}

export class WsTicketService {
  private tickets: Map<string, TicketEntry> = new Map();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Issue a ticket letting `userId` open the VNC WebSocket of `sessionId` once
   */
  issue(userId: string, sessionId: string): { ticket: string; expiresInMs: number } {
    this.pruneExpired();
    const ticket = crypto.randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { userId, sessionId, expiresAt: this.now() + TICKET_TTL_MS });
    return { ticket, expiresInMs: TICKET_TTL_MS };
  }

  /**
   * Consume a ticket. Returns the user it was issued to, or null if it is
   * unknown, expired, already used, or for a different session.
   */
  redeem(ticket: string, sessionId: string): string | null {
    const entry = this.tickets.get(ticket);
    if (!entry) return null;

    this.tickets.delete(ticket);
    if (entry.expiresAt < this.now() || entry.sessionId !== sessionId) {
      return null;
    }
    return entry.userId;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt < now) {
        this.tickets.delete(ticket);
      }
    }
  }
}

export const wsTicketService = new WsTicketService();

export default wsTicketService;
