import net from 'net';
import WebSocket from 'ws';
import { logger } from '../utils/logger';
import { RfbClientFilter } from './rfbClientFilter';

export type ViewerPermission = 'view' | 'control';

interface ViewerConnection {
  userId: string;
  ws: WebSocket;
  tcp: net.Socket;
  permissions: ViewerPermission;
  joinedAt: Date;
  isOwner: boolean;
  closed: boolean;
}

interface SessionBridgeOptions {
  sessionId: string;
  tunnelHost: string;
  tunnelPort: number;
  ownerId: string;
}

const toBuffer = (data: WebSocket.RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

/**
 * SessionBridge connects the WebSocket clients of one session to the VNC server
 * behind the session's SSH tunnel.
 *
 * Architecture:
 * - Each WebSocket client gets its own TCP connection through the tunnel, and so
 *   its own RFB handshake and framebuffer state. The VNC server runs with
 *   -AlwaysShared, so all clients see and share the same desktop, and a client
 *   that reconnects starts a clean handshake.
 * - The owner's stream is passed through untouched. Other participants' streams
 *   go through an RfbClientFilter, which drops keyboard/pointer/clipboard/resize
 *   input unless they currently have 'control' permission.
 * - One connection per user: reconnecting (e.g. a reloaded tab) replaces the old one.
 */
export class SessionBridge {
  readonly sessionId: string;
  readonly tunnelPort: number;
  private readonly tunnelHost: string;
  private readonly ownerId: string;
  private readonly onEmpty?: () => void;
  private viewers: Map<string, ViewerConnection> = new Map();

  constructor(options: SessionBridgeOptions, onEmpty?: () => void) {
    this.sessionId = options.sessionId;
    this.tunnelHost = options.tunnelHost;
    this.tunnelPort = options.tunnelPort;
    this.ownerId = options.ownerId;
    this.onEmpty = onEmpty;
  }

  /**
   * Connect a WebSocket client to the VNC server. Rejects if the tunnel can't be
   * reached; the caller is responsible for closing the WebSocket in that case.
   */
  async addViewer(
    userId: string,
    ws: WebSocket,
    permissions: ViewerPermission,
    isOwner: boolean = false
  ): Promise<void> {
    const tcp = await this.openTunnelConnection();

    // The client may have gone away while we were connecting
    if (ws.readyState !== WebSocket.OPEN) {
      tcp.destroy();
      return;
    }

    const existing = this.viewers.get(userId);
    if (existing) {
      logger.info(`[SessionBridge] Replacing existing connection for user ${userId}`);
      this.closeViewer(existing, 1000, 'New connection established', false);
    }

    const viewer: ViewerConnection = {
      userId,
      ws,
      tcp,
      permissions: isOwner ? 'control' : permissions, // Owner always has control
      joinedAt: new Date(),
      isOwner,
      closed: false,
    };
    this.viewers.set(userId, viewer);

    const filter = isOwner ? null : new RfbClientFilter(() => viewer.permissions === 'control');

    tcp.on('data', (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
    tcp.on('close', () => this.closeViewer(viewer, 1000, 'VNC connection closed'));
    tcp.on('error', (error) => {
      logger.warn(`[SessionBridge] VNC connection error for viewer ${userId} in session ${this.sessionId}:`, error);
      this.closeViewer(viewer, 1011, 'VNC connection error');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (viewer.closed) return;
      const chunk = toBuffer(data);

      if (!filter) {
        tcp.write(chunk);
        return;
      }

      try {
        const allowed = filter.process(chunk);
        if (allowed.length > 0) {
          tcp.write(allowed);
        }
      } catch (error) {
        logger.warn(`[SessionBridge] Closing viewer ${userId}: unparseable VNC client stream`, {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.closeViewer(viewer, 1008, 'Unsupported VNC client message');
      }
    });
    ws.on('close', () => this.closeViewer(viewer));
    ws.on('error', (error) => {
      logger.error(`[SessionBridge] WebSocket error for viewer ${userId}:`, error);
      this.closeViewer(viewer);
    });

    logger.info(`[SessionBridge] Viewer ${userId} joined session ${this.sessionId} with ${viewer.permissions} permissions`);
  }

  private openTunnelConnection(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.tunnelHost, port: this.tunnelPort });
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        socket.setNoDelay(true);
        resolve(socket);
      });
    });
  }

  /**
   * Tear down one viewer's WebSocket and TCP connection. Safe to call repeatedly.
   */
  private closeViewer(viewer: ViewerConnection, code?: number, reason?: string, notifyEmpty: boolean = true): void {
    if (viewer.closed) return;
    viewer.closed = true;

    if (this.viewers.get(viewer.userId) === viewer) {
      this.viewers.delete(viewer.userId);
    }

    viewer.tcp.destroy();

    if (viewer.ws.readyState === WebSocket.OPEN || viewer.ws.readyState === WebSocket.CONNECTING) {
      try {
        viewer.ws.close(code ?? 1000, reason);
      } catch (error) {
        logger.warn(`[SessionBridge] Error closing WebSocket for viewer ${viewer.userId}:`, error);
        viewer.ws.terminate();
      }
    }

    logger.info(`[SessionBridge] Viewer ${viewer.userId} left session ${this.sessionId}`);

    if (notifyEmpty && this.viewers.size === 0) {
      this.onEmpty?.();
    }
  }

  /**
   * Get list of current viewers (for API/UI)
   */
  getViewerList(): Array<{
    userId: string;
    permissions: ViewerPermission;
    joinedAt: Date;
    isOwner: boolean;
  }> {
    return Array.from(this.viewers.values()).map((v) => ({
      userId: v.userId,
      permissions: v.permissions,
      joinedAt: v.joinedAt,
      isOwner: v.isOwner,
    }));
  }

  /**
   * Get viewer count
   */
  getViewerCount(): number {
    return this.viewers.size;
  }

  /**
   * Check if a user is connected to this session
   */
  hasViewer(userId: string): boolean {
    return this.viewers.has(userId);
  }

  /**
   * Update a viewer's permissions; takes effect at their next VNC message
   */
  updateViewerPermissions(userId: string, permissions: ViewerPermission): boolean {
    const viewer = this.viewers.get(userId);
    if (!viewer || viewer.isOwner) return false;

    viewer.permissions = permissions;
    logger.info(`[SessionBridge] Viewer ${userId} in session ${this.sessionId} now has ${permissions} permissions`);
    return true;
  }

  /**
   * Disconnect a viewer from the session
   */
  kickViewer(userId: string, reason: string = 'Removed by session owner'): boolean {
    const viewer = this.viewers.get(userId);
    if (!viewer || viewer.isOwner) return false;

    this.closeViewer(viewer, 1000, reason);
    return true;
  }

  /**
   * Disconnect every participant except the owner (e.g. collaboration turned off)
   */
  kickAllGuests(reason: string): number {
    let kicked = 0;
    for (const viewer of Array.from(this.viewers.values())) {
      if (!viewer.isOwner) {
        this.closeViewer(viewer, 1000, reason);
        kicked++;
      }
    }
    return kicked;
  }

  /**
   * Get the session owner ID
   */
  getOwnerId(): string {
    return this.ownerId;
  }

  /**
   * Close all connections to this session
   */
  close(reason: string = 'Session ended'): void {
    logger.info(`[SessionBridge] Closing bridge for session ${this.sessionId}`);
    for (const viewer of Array.from(this.viewers.values())) {
      this.closeViewer(viewer, 1000, reason, false);
    }
  }
}

/**
 * SessionBridgeManager manages all active session bridges
 */
export class SessionBridgeManager {
  private bridges: Map<string, SessionBridge> = new Map();

  /**
   * Get or create the bridge for a session
   */
  getOrCreateBridge(options: SessionBridgeOptions): SessionBridge {
    const existing = this.bridges.get(options.sessionId);
    if (existing && existing.tunnelPort === options.tunnelPort) {
      return existing;
    }
    existing?.close();

    const bridge = new SessionBridge(options, () => {
      // Drop bridges nobody is connected to; the next viewer creates a new one
      if (this.bridges.get(options.sessionId) === bridge) {
        this.bridges.delete(options.sessionId);
      }
    });
    this.bridges.set(options.sessionId, bridge);

    logger.info(`[SessionBridgeManager] Created bridge for session ${options.sessionId}`);
    return bridge;
  }

  /**
   * Get an existing bridge
   */
  getBridge(sessionId: string): SessionBridge | undefined {
    return this.bridges.get(sessionId);
  }

  /**
   * Close and remove a bridge
   */
  closeBridge(sessionId: string, reason?: string): void {
    const bridge = this.bridges.get(sessionId);
    if (bridge) {
      this.bridges.delete(sessionId);
      bridge.close(reason);
      logger.info(`[SessionBridgeManager] Closed bridge for session ${sessionId}`);
    }
  }

  /**
   * Get IDs of sessions that currently have at least one connected viewer
   */
  getActiveSessions(): string[] {
    return Array.from(this.bridges.values())
      .filter((bridge) => bridge.getViewerCount() > 0)
      .map((bridge) => bridge.sessionId);
  }

  /**
   * Get total viewer count across all sessions
   */
  getTotalViewerCount(): number {
    let total = 0;
    for (const bridge of this.bridges.values()) {
      total += bridge.getViewerCount();
    }
    return total;
  }

  /**
   * Close all bridges
   */
  closeAll(): void {
    for (const bridge of this.bridges.values()) {
      bridge.close('Server shutting down');
    }
    this.bridges.clear();
    logger.info('[SessionBridgeManager] All bridges closed');
  }
}

// Export singleton instance
export const sessionBridgeManager = new SessionBridgeManager();
