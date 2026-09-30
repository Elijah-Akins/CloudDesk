import WebSocket from 'ws';
import { logger } from '../utils/logger';
import { WSConnectionInfo } from '../types';

interface ConnectionEntry {
  ws: WebSocket;
  info: WSConnectionInfo;
  isAlive: boolean;
  missedPongs: number;
}

/**
 * Tracks VNC WebSocket connections and pings them to detect dead peers.
 *
 * Connections are keyed by a per-connection ID, not by session: a shared
 * session has one connection per participant.
 */
class ConnectionManager {
  private connections: Map<string, ConnectionEntry> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 60000; // 60 seconds
  private readonly MAX_MISSED_PONGS = 3; // Allow 3 missed pongs before disconnect

  /**
   * Start the heartbeat checker
   */
  startHeartbeat(): void {
    if (this.heartbeatInterval) {
      return;
    }

    this.heartbeatInterval = setInterval(() => {
      this.checkConnections();
    }, this.HEARTBEAT_INTERVAL);

    logger.info('WebSocket heartbeat started');
  }

  /**
   * Stop the heartbeat checker
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.info('WebSocket heartbeat stopped');
    }
  }

  /**
   * Register a connection. It is forgotten automatically when the socket closes.
   */
  addConnection(connectionId: string, ws: WebSocket, info: WSConnectionInfo): void {
    const entry: ConnectionEntry = {
      ws,
      info,
      isAlive: true,
      missedPongs: 0,
    };

    this.connections.set(connectionId, entry);

    ws.on('pong', () => {
      entry.isAlive = true;
      entry.missedPongs = 0;
    });

    ws.once('close', () => {
      if (this.connections.get(connectionId) === entry) {
        this.connections.delete(connectionId);
      }
    });

    logger.debug(`WebSocket connection added: ${connectionId} (session ${info.sessionId})`);
  }

  /**
   * Close and forget a connection
   */
  removeConnection(connectionId: string, terminate: boolean = false): void {
    const entry = this.connections.get(connectionId);
    if (!entry) return;

    this.connections.delete(connectionId);

    try {
      if (terminate) {
        entry.ws.terminate();
      } else if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.close();
      }
    } catch (error) {
      logger.warn(`Error closing WebSocket ${connectionId}:`, error);
    }

    logger.debug(`WebSocket connection removed: ${connectionId}`);
  }

  /**
   * Close every connection to a session
   */
  removeSessionConnections(sessionId: string): number {
    let closed = 0;
    for (const [connectionId, entry] of Array.from(this.connections)) {
      if (entry.info.sessionId === sessionId) {
        this.removeConnection(connectionId);
        closed++;
      }
    }
    return closed;
  }

  /**
   * Get all connections for a user
   */
  getConnectionsByUser(userId: string): Array<{ connectionId: string; info: WSConnectionInfo }> {
    const result: Array<{ connectionId: string; info: WSConnectionInfo }> = [];

    for (const [connectionId, entry] of this.connections) {
      if (entry.info.userId === userId) {
        result.push({ connectionId, info: entry.info });
      }
    }

    return result;
  }

  /**
   * Close all connections for a user
   */
  closeConnectionsByUser(userId: string): number {
    let closedCount = 0;

    for (const [connectionId, entry] of Array.from(this.connections)) {
      if (entry.info.userId === userId) {
        this.removeConnection(connectionId);
        closedCount++;
      }
    }

    return closedCount;
  }

  /**
   * Get total connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get IDs of sessions with at least one connection
   */
  getActiveSessions(): string[] {
    return Array.from(new Set(Array.from(this.connections.values(), (entry) => entry.info.sessionId)));
  }

  /**
   * Ping every connection and drop the ones that stopped answering
   */
  private checkConnections(): void {
    for (const [connectionId, entry] of Array.from(this.connections)) {
      if (!entry.isAlive) {
        entry.missedPongs++;
        logger.debug(`Connection ${connectionId} missed pong (${entry.missedPongs}/${this.MAX_MISSED_PONGS})`);

        if (entry.missedPongs >= this.MAX_MISSED_PONGS) {
          logger.warn(`WebSocket connection dead after ${this.MAX_MISSED_PONGS} missed pongs, removing: ${connectionId}`);
          // A dead peer won't complete a close handshake
          this.removeConnection(connectionId, true);
          continue;
        }
      }

      // Mark as not alive, will be set to true on pong
      entry.isAlive = false;

      try {
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.ping();
        }
      } catch (error) {
        logger.warn(`Error sending ping to ${connectionId}:`, error);
        this.removeConnection(connectionId, true);
      }
    }
  }

  /**
   * Close all connections
   */
  closeAll(): void {
    for (const connectionId of Array.from(this.connections.keys())) {
      this.removeConnection(connectionId);
    }

    logger.info('All WebSocket connections closed');
  }
}

// Export singleton instance
export const connectionManager = new ConnectionManager();

export default connectionManager;
