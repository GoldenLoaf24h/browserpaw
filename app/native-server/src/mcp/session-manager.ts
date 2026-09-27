import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createMcpServerInstance } from './mcp-server';
import { clearSessionExtraTools } from './register-tools';
import { randomUUID } from 'node:crypto';

export interface SessionTransport {
  sessionId: string;
  transport: Transport;
  server: Server;
  createdAt: number;
  lastActiveAt: number;
}

export class McpSessionManager {
  private sessions: Map<string, SessionTransport> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(autoCleanup = true, sweepIntervalMs = 60_000) {
    if (autoCleanup) {
      this.cleanupTimer = setInterval(() => {
        // Default: prune sessions inactive for > 10 minutes
        this.cleanupStaleSessions(10 * 60 * 1000);
      }, sweepIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  /**
   * Instantiate an isolated MCP Server instance for this transport and bind lifecycle.
   */
  public async createSession(
    transport: Transport,
    customSessionId?: string,
  ): Promise<{ sessionId: string; server: Server }> {
    const sessionId = customSessionId || (transport as any).sessionId || randomUUID();

    // Create a fresh isolated Server instance per connection with session affinity
    const server = createMcpServerInstance(sessionId);

    // Connect isolated server to transport
    await server.connect(transport);

    const now = Date.now();
    const entry: SessionTransport = {
      sessionId,
      transport,
      server,
      createdAt: now,
      lastActiveAt: now,
    };

    this.sessions.set(sessionId, entry);

    // Clean up on transport close
    const origClose = transport.onclose;
    transport.onclose = () => {
      try {
        if (origClose) {
          origClose();
        }
      } finally {
        this.sessions.delete(sessionId);
        clearSessionExtraTools(sessionId);
      }
    };

    return { sessionId, server };
  }

  /**
   * Retrieve active session and refresh its activity timestamp.
   */
  public getSession(sessionId: string): SessionTransport | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActiveAt = Date.now();
    }
    return session;
  }

  public hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Gracefully close server and transport for a specific session.
   */
  public async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearSessionExtraTools(sessionId);

    try {
      await session.server.close();
    } catch {
      // Ignore errors during server close
    }

    try {
      await session.transport.close();
    } catch {
      // Ignore errors during transport close
    }
  }

  /**
   * Periodically remove sessions exceeding max idle time.
   */
  public cleanupStaleSessions(maxIdleMs: number = 300_000): number {
    const now = Date.now();
    let reaped = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActiveAt > maxIdleMs) {
        this.closeSession(sessionId).catch(() => {});
        reaped++;
      }
    }
    return reaped;
  }

  /**
   * Close all active sessions immediately (used on server stop).
   */
  public async closeAllSessions(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const sessionIds = Array.from(this.sessions.keys());
    await Promise.allSettled(sessionIds.map((id) => this.closeSession(id)));
    this.sessions.clear();
  }

  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  public getAllSessions(): SessionTransport[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Broadcast tool list changed event to all connected MCP client sessions.
   */
  public broadcastToolListChanged(): void {
    for (const session of this.sessions.values()) {
      if (session.server && typeof (session.server as any).sendToolListChanged === 'function') {
        (session.server as any).sendToolListChanged().catch(() => {});
      }
    }
  }
}

export const mcpSessionManager = new McpSessionManager();
