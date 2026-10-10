/**
 * WebSocket service — real-time notifications and presence.
 *
 * Supports:
 *   - Authenticated connections: the access token travels as a WebSocket
 *     subprotocol (`new WebSocket(url, ['bies.v1', token])`), not in the URL,
 *     which proxies write to their logs. The session is checked on connect,
 *     and its sockets close when it ends (logout, ban, deletion).
 *   - Per-user notification push
 *   - Typing indicators for DMs
 *   - Online presence tracking
 *   - Heartbeat / keepalive (prevents proxy timeouts)
 *
 * Scales to 500+ concurrent connections on a single Node process.
 * For multi-instance horizontal scaling, swap the in-process Map for
 * a Redis Pub/Sub adapter (e.g. socket.io-redis or ioredis pub/sub).
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import { config } from '../config';
import { checkSession, onSessionsEnded, verifyAccessToken } from './session.service';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthenticatedWebSocket extends WebSocket {
    userId?: string;
    sessionId?: string;
    isAlive?: boolean;
}

interface WsMessage {
    type: string;
    [key: string]: unknown;
}

// ─── Connection store ─────────────────────────────────────────────────────────

// userId → Set of open WebSocket connections (one user can have multiple tabs)
const connections = new Map<string, Set<AuthenticatedWebSocket>>();

// ─── Authentication ───────────────────────────────────────────────────────────

/** The subprotocol the app asks for; the second one it offers is its token. */
export const WS_PROTOCOL = 'bies.v1';

// Close codes the app acts on: refresh the token and reconnect, or sign out.
const CLOSE_REFRESH = 4001;
const CLOSE_SESSION_ENDED = 4003;

function tokenFromRequest(req: IncomingMessage): string | null {
    const offered = (req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim());
    if (offered[0] !== WS_PROTOCOL || !offered[1]) return null;
    return offered[1];
}

// ─── Public API ───────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;

/**
 * Attach a WebSocket server to the existing HTTP server.
 * Call this once from index.ts after creating the http.Server.
 */
export function attachWebSocketServer(httpServer: Server): void {
    wss = new WebSocketServer({
        server: httpServer,
        path: '/ws',
        maxPayload: 64 * 1024,
        // Answer with our protocol name, never with the token.
        handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    });

    // A session that ends closes its sockets: logout on this device, or a
    // ban, deletion or merge for every device.
    onSessionsEnded(({ sessionId, userId }) => {
        for (const sockets of connections.values()) {
            for (const ws of sockets) {
                if ((sessionId && ws.sessionId === sessionId) || (userId && ws.userId === userId)) {
                    ws.close(CLOSE_SESSION_ENDED, 'session_ended');
                }
            }
        }
    });

    wss.on('connection', (ws: AuthenticatedWebSocket, req: IncomingMessage) => {
        // Not yet registered, but the heartbeat must not cut it off mid-check.
        ws.isAlive = true;
        const token = tokenFromRequest(req);
        if (!token) {
            ws.close(CLOSE_REFRESH, 'Authentication required');
            return;
        }

        const checked = verifyAccessToken(token);
        if (!checked.ok) {
            ws.close(CLOSE_REFRESH, checked.reason);
            return;
        }

        // Messages that arrive before the session check are dropped: the
        // listeners below aren't attached yet.
        checkSession(checked.claims.sid, checked.claims.userId).then((session) => {
            if (!session.ok) {
                ws.close(CLOSE_SESSION_ENDED, session.reason);
                return;
            }
            if (ws.readyState !== WebSocket.OPEN) return;
            register(ws, session.user.id, checked.claims.sid);
        }).catch((err) => {
            console.error('[WS] Session check failed:', err);
            ws.close(1011, 'Try again');
        });
    });

    function register(ws: AuthenticatedWebSocket, userId: string, sessionId: string): void {
        ws.userId = userId;
        ws.sessionId = sessionId;
        ws.isAlive = true;

        // Track connection
        if (!connections.has(userId)) connections.set(userId, new Set());
        connections.get(userId)!.add(ws);

        console.log(`[WS] User ${userId} connected (total: ${countConnections()})`);

        // Send a welcome ping
        sendToSocket(ws, { type: 'connected', userId });

        // Pong handler for keepalive
        ws.on('pong', () => { ws.isAlive = true; });

        // Incoming messages from client
        ws.on('message', (data: Buffer) => {
            try {
                const msg: WsMessage = JSON.parse(data.toString());
                handleClientMessage(ws, userId, msg);
            } catch {
                // Ignore malformed messages
            }
        });

        ws.on('close', () => {
            connections.get(userId)?.delete(ws);
            if (connections.get(userId)?.size === 0) connections.delete(userId);
            console.log(`[WS] User ${userId} disconnected (total: ${countConnections()})`);
        });

        ws.on('error', (err) => {
            console.error(`[WS] Error for user ${userId}:`, err.message);
        });
    }

    // Heartbeat: ping all connections every 30s to detect dead sockets
    const heartbeat = setInterval(() => {
        wss!.clients.forEach((ws) => {
            const socket = ws as AuthenticatedWebSocket;
            if (!socket.isAlive) {
                socket.terminate();
                return;
            }
            socket.isAlive = false;
            socket.ping();
        });
    }, 30_000);

    wss.on('close', () => clearInterval(heartbeat));

    console.log(`[WS] WebSocket server ready at ws://localhost:${config.port}/ws`);
}

// ─── Client message handling ──────────────────────────────────────────────────

function handleClientMessage(
    ws: AuthenticatedWebSocket,
    userId: string,
    msg: WsMessage
): void {
    switch (msg.type) {
        case 'ping':
            sendToSocket(ws, { type: 'pong' });
            break;

        case 'typing_start':
        case 'typing_stop':
            // Relay typing indicator to recipient
            if (msg.recipientId && typeof msg.recipientId === 'string') {
                sendToUser(msg.recipientId as string, {
                    type: msg.type,
                    fromUserId: userId,
                });
            }
            break;

        case 'mark_read':
            // Client acknowledges reading messages — handled via REST but we can relay here too
            break;

        default:
            break;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendToSocket(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function countConnections(): number {
    let count = 0;
    for (const sockets of connections.values()) count += sockets.size;
    return count;
}

// ─── Exported helpers for use throughout the app ─────────────────────────────

/**
 * Push a message to all open sockets for a user.
 * Returns the number of sockets the message was sent to.
 */
export function sendToUser(userId: string, data: unknown): number {
    const sockets = connections.get(userId);
    if (!sockets || sockets.size === 0) return 0;

    let sent = 0;
    for (const ws of sockets) {
        sendToSocket(ws, data);
        sent++;
    }
    return sent;
}

/**
 * Broadcast to all connected users (e.g. system announcements).
 * Use sparingly.
 */
export function broadcast(data: unknown): void {
    // Signed-in sockets only, not ones still waiting on their session check.
    for (const sockets of connections.values()) {
        for (const ws of sockets) sendToSocket(ws, data);
    }
}

/**
 * Check if a user has at least one open WebSocket connection (is online).
 */
export function isUserOnline(userId: string): boolean {
    return (connections.get(userId)?.size ?? 0) > 0;
}

/**
 * Get all online user IDs.
 */
export function getOnlineUserIds(): string[] {
    return Array.from(connections.keys());
}
