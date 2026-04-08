import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'tradhub-dev-secret-change-in-production';

// Map of userId -> { ws, role, jobId }
const clients = new Map();

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    let userId = null;
    let userRole = null;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
      userRole = decoded.role;
    } catch {
      ws.close(1008, 'Invalid token');
      return;
    }

    // Register connection
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(ws);
    ws._role = userRole;
    ws._userId = userId;

    // Handle incoming messages (tradesman location updates)
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        // Tradesman broadcasting their GPS location
        if (msg.type === 'location_update' && userRole === 'tradesman') {
          // Forward to all homeowners who have an in_progress job with this tradesman
          // Broadcast to all connected clients — frontend filters by job ownership
          broadcastToRole('homeowner', {
            type: 'tradesman_location',
            lat: msg.lat,
            lng: msg.lng,
            tradesmanId: userId,
          });
        }
      } catch { /* ignore malformed messages */ }
    });

    ws.on('close', () => {
      const sockets = clients.get(userId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) clients.delete(userId);
      }
    });

    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'connected', userId }));
  });

  return wss;
}

export function notifyUser(userId, payload) {
  const sockets = clients.get(userId);
  if (!sockets || sockets.size === 0) return;
  const data = JSON.stringify(payload);
  sockets.forEach(ws => {
    if (ws.readyState === 1) ws.send(data);
  });
}

export function broadcast(payload) {
  const data = JSON.stringify(payload);
  clients.forEach(sockets => {
    sockets.forEach(ws => {
      if (ws.readyState === 1) ws.send(data);
    });
  });
}

function broadcastToRole(role, payload) {
  const data = JSON.stringify(payload);
  clients.forEach(sockets => {
    sockets.forEach(ws => {
      if (ws.readyState === 1 && ws._role === role) ws.send(data);
    });
  });
}
