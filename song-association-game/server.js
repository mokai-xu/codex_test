import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// In-memory room storage
const rooms = new Map();

// Track which room each client is in
const clientRooms = new WeakMap();

// Server-side lyrics cache (5 minute TTL)
const lyricsCache = new Map();
const LYRICS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_LYRICS_CACHE_SIZE = 500;

// Clean up expired cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of lyricsCache.entries()) {
    if (now - value.timestamp > LYRICS_CACHE_TTL) {
      lyricsCache.delete(key);
    }
  }
  // Limit cache size
  if (lyricsCache.size > MAX_LYRICS_CACHE_SIZE) {
    const entries = Array.from(lyricsCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.slice(0, entries.length - MAX_LYRICS_CACHE_SIZE);
    toRemove.forEach(([key]) => lyricsCache.delete(key));
  }
}, 60000); // Clean up every minute

// Helper function to generate IDs
function generateId() {
  return randomUUID();
}

// MIME types for static files
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Lyrics API base URL
const LYRICS_API_BASE = process.env.LYRICS_API_BASE || 'https://lyrics.lewdhutao.my.eu.org';

// HTTP server that serves static files and handles WebSocket upgrades
const httpServer = createServer(async (req, res) => {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }

  // Lyrics proxy endpoint
  if (req.url?.startsWith('/api/lyrics')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const title = url.searchParams.get('title');
      const artist = url.searchParams.get('artist');

      if (!title || !artist) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: 'Missing title or artist parameter' }));
        return;
      }

      // Check server-side cache first
      const cacheKey = `${title.toLowerCase().trim()}|${artist.toLowerCase().trim()}`;
      const cached = lyricsCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < LYRICS_CACHE_TTL) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(cached.data));
        return;
      }

      // Try both endpoints in parallel with Promise.race for faster response
      const endpoints = [
        `${LYRICS_API_BASE}/v2/youtube/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
        `${LYRICS_API_BASE}/v2/musixmatch/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`
      ];

      const attempts = endpoints.map(async (endpoint) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000); // Reduced from 3000ms

        try {
          const response = await fetch(endpoint, { signal: controller.signal });
          if (!response.ok) {
            return null;
          }
          const payload = await response.json();
          
          if (payload.data?.lyrics) {
            const lyrics = payload.data.lyrics.trim();
            // Filter out placeholder text or restricted lyrics
            if (lyrics && lyrics.length > 10 && !lyrics.includes('...')) {
              return { lyrics };
            }
          }
          return null;
        } catch (error) {
          return null;
        } finally {
          clearTimeout(timeoutId);
        }
      });

      // Use Promise.race to return immediately on first success
      try {
        const result = await Promise.race(attempts);
        if (result && result.lyrics) {
          // Cache the result
          lyricsCache.set(cacheKey, { data: result, timestamp: Date.now() });
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify(result));
          return;
        }
      } catch {
        // Race failed, check all results
      }

      // Fallback: check all results if race didn't return valid result
      const results = await Promise.allSettled(attempts);
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value && result.value.lyrics) {
          // Cache the result
          lyricsCache.set(cacheKey, { data: result.value, timestamp: Date.now() });
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify(result.value));
          return;
        }
      }

      // No lyrics found
      res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'Lyrics not found' }));
    } catch (error) {
      console.error('Error in lyrics proxy:', error);
      res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return;
  }

  // In production, serve static files from dist/
  if (isProduction) {
    let filePath = join(__dirname, 'dist', req.url === '/' ? 'index.html' : req.url);
    
    // Security: prevent directory traversal
    if (!filePath.startsWith(join(__dirname, 'dist'))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Check if file exists
    if (existsSync(filePath) && !filePath.endsWith('/')) {
      const ext = extname(filePath);
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      
      try {
        const content = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return;
      } catch (error) {
        console.error('Error serving file:', error);
      }
    } else {
      // For SPA routing, serve index.html for non-API routes
      const indexPath = join(__dirname, 'dist', 'index.html');
      if (existsSync(indexPath)) {
        try {
          const content = readFileSync(indexPath);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
          return;
        } catch (error) {
          console.error('Error serving index.html:', error);
        }
      }
    }
  }

  // 404 for everything else
  res.writeHead(404);
  res.end('Not found');
});

// WebSocket server attached to HTTP server (same port)
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let currentRoomId = null;
  let deviceId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'join-room': {
          const { roomId, deviceId: devId } = data;
          currentRoomId = roomId;
          deviceId = devId;
          
          // Track which room this client is in
          clientRooms.set(ws, roomId);

          // Get or create room
          if (!rooms.has(roomId)) {
            rooms.set(roomId, {
              roomId,
              players: [],
              phase: 'lobby',
              roundDuration: 20,
              roundWords: [],
              currentRound: 0,
              playersWithScores: [],
              history: [],
              gameMasterId: null,
              lastUpdated: Date.now()
            });
          }

          const room = rooms.get(roomId);
          
          // Send current room state
          ws.send(JSON.stringify({
            type: 'room-state',
            state: room
          }));

          // Broadcast to other clients in room
          broadcastToRoom(roomId, {
            type: 'room-state',
            state: room
          }, ws);

          break;
        }

        case 'add-player': {
          const { playerName, deviceId: devId, roomId } = data;
          
          // If roomId is provided, ensure we're in that room
          if (roomId && roomId !== currentRoomId) {
            currentRoomId = roomId;
            deviceId = devId;
            clientRooms.set(ws, roomId);
            
            // Get or create room
            if (!rooms.has(roomId)) {
              rooms.set(roomId, {
                roomId,
                players: [],
                phase: 'lobby',
                roundDuration: 20,
                roundWords: [],
                currentRound: 0,
                playersWithScores: [],
                history: [],
                gameMasterId: null,
                lastUpdated: Date.now()
              });
            }
          }
          
          if (!currentRoomId) {
            // Can't add player without being in a room
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Must join a room before adding a player'
            }));
            break;
          }
          
          const room = rooms.get(currentRoomId);
          if (!room) break;

          // Check if device already has a player
          const existingPlayer = room.players.find(p => p.deviceId === devId);
          if (existingPlayer) {
            // Update name if changed
            if (existingPlayer.name !== playerName) {
              existingPlayer.name = playerName;
            }
          } else {
            // Add new player
            const playerId = generateId();
            const newPlayer = { id: playerId, name: playerName, deviceId: devId };
            room.players.push(newPlayer);
            
            // First player becomes game master
            if (!room.gameMasterId) {
              room.gameMasterId = playerId;
            }
          }

          room.lastUpdated = Date.now();
          rooms.set(currentRoomId, room);

          // Broadcast updated state to ALL clients including sender
          broadcastToRoom(currentRoomId, {
            type: 'room-state',
            state: room
          });
          
          // Also send directly to the sender to ensure they get the update
          ws.send(JSON.stringify({
            type: 'room-state',
            state: room
          }));

          break;
        }

        case 'remove-player': {
          if (!currentRoomId) break;
          const room = rooms.get(currentRoomId);
          if (!room) break;

          const { deviceId: devId } = data;
          room.players = room.players.filter(p => p.deviceId !== devId);

          // If game master left, assign new one
          if (room.gameMasterId && !room.players.find(p => p.id === room.gameMasterId)) {
            room.gameMasterId = room.players.length > 0 ? room.players[0].id : null;
          }

          room.lastUpdated = Date.now();
          rooms.set(currentRoomId, room);

          // Broadcast updated state to ALL clients including sender
          broadcastToRoom(currentRoomId, {
            type: 'room-state',
            state: room
          });
          
          // Also send directly to the sender to ensure they get the update
          ws.send(JSON.stringify({
            type: 'room-state',
            state: room
          }));

          break;
        }

        case 'update-room': {
          if (!currentRoomId) break;
          const room = rooms.get(currentRoomId);
          if (!room) break;

          // Only game master can update room state
          const { updates, deviceId: devId } = data;
          const player = room.players.find(p => p.deviceId === devId);
          
          if (player && player.id === room.gameMasterId) {
            Object.assign(room, updates);
            room.lastUpdated = Date.now();
            rooms.set(currentRoomId, room);

            // Broadcast updated state to ALL clients including sender
            broadcastToRoom(currentRoomId, {
              type: 'room-state',
              state: room
            });
            
            // Also send directly to the sender to ensure they get the update
            ws.send(JSON.stringify({
              type: 'room-state',
              state: room
            }));
          }

          break;
        }

        case 'player-submission': {
          if (!currentRoomId) break;
          const room = rooms.get(currentRoomId);
          if (!room) break;

          const { playerId, word, song, artist, deviceId: devId } = data;
          const player = room.players.find(p => p.deviceId === devId);
          
          if (player && player.id === playerId) {
            // Update player score
            let playerWithScore = room.playersWithScores.find(p => p.id === playerId);
            if (!playerWithScore) {
              playerWithScore = { id: playerId, name: player.name, score: 0 };
              room.playersWithScores.push(playerWithScore);
            }
            playerWithScore.score += 1;

            // Add to history
            room.history.push({
              word,
              outcome: 'success',
              winnerId: playerId,
              song,
              artist
            });

            // Advance round
            room.currentRound += 1;
            if (room.currentRound >= room.roundWords.length) {
              room.phase = 'leaderboard';
            }

            room.lastUpdated = Date.now();
            rooms.set(currentRoomId, room);

            // Broadcast updated state
            broadcastToRoom(currentRoomId, {
              type: 'room-state',
              state: room
            });
          }

          break;
        }

        case 'round-timeout': {
          if (!currentRoomId) break;
          const room = rooms.get(currentRoomId);
          if (!room) break;

          const { word, deviceId: devId } = data;
          const player = room.players.find(p => p.deviceId === devId);
          
          // Only game master can trigger timeout
          if (player && player.id === room.gameMasterId) {
            room.history.push({
              word,
              outcome: 'timeout'
            });

            room.currentRound += 1;
            if (room.currentRound >= room.roundWords.length) {
              room.phase = 'leaderboard';
            }

            room.lastUpdated = Date.now();
            rooms.set(currentRoomId, room);

            // Broadcast updated state to ALL clients including sender
            broadcastToRoom(currentRoomId, {
              type: 'room-state',
              state: room
            });
            
            // Also send directly to the sender to ensure they get the update
            ws.send(JSON.stringify({
              type: 'room-state',
              state: room
            }));
          }

          break;
        }

        case 'round-skip': {
          if (!currentRoomId) break;
          const room = rooms.get(currentRoomId);
          if (!room) break;

          const { word, deviceId: devId } = data;
          const player = room.players.find(p => p.deviceId === devId);
          
          // Only game master can skip
          if (player && player.id === room.gameMasterId) {
            room.history.push({
              word,
              outcome: 'skipped'
            });

            room.currentRound += 1;
            if (room.currentRound >= room.roundWords.length) {
              room.phase = 'leaderboard';
            }

            room.lastUpdated = Date.now();
            rooms.set(currentRoomId, room);

            // Broadcast updated state to ALL clients including sender
            broadcastToRoom(currentRoomId, {
              type: 'room-state',
              state: room
            });
            
            // Also send directly to the sender to ensure they get the update
            ws.send(JSON.stringify({
              type: 'room-state',
              state: room
            }));
          }

          break;
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  ws.on('close', () => {
    // Clean up if needed
    if (currentRoomId && deviceId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.players = room.players.filter(p => p.deviceId !== deviceId);
        
        // If game master left, assign new one
        if (room.gameMasterId && !room.players.find(p => p.id === room.gameMasterId)) {
          room.gameMasterId = room.players.length > 0 ? room.players[0].id : null;
        }

        room.lastUpdated = Date.now();
        rooms.set(currentRoomId, room);

        // Broadcast updated state
        broadcastToRoom(currentRoomId, {
          type: 'room-state',
          state: room
        }, ws);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function broadcastToRoom(roomId, message, excludeWs = null) {
  wss.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === 1) {
      const clientRoomId = clientRooms.get(client);
      // Only send to clients in the same room
      if (clientRoomId === roomId) {
        client.send(JSON.stringify(message));
      }
    }
  });
}

// Clean up old rooms (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.lastUpdated > 3600000) {
      rooms.delete(roomId);
      console.log(`Cleaned up room ${roomId}`);
    }
  }
}, 60000); // Check every minute

// Start server
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`HTTP server: http://localhost:${PORT}`);
  console.log(`WebSocket server: ws://localhost:${PORT}`);
  if (isProduction) {
    console.log('Production mode: serving static files from dist/');
  }
});

