import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const WS_PORT = process.env.WS_PORT || 3002;

// In-memory room storage
const rooms = new Map();

// HTTP server for health checks
const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// WebSocket server
const wss = new WebSocketServer({ port: WS_PORT });

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
          if (!currentRoomId) break;
          const room = rooms.get(currentRoomId);
          if (!room) break;

          const { playerName, deviceId: devId } = data;
          
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

          // Broadcast updated state to all clients
          broadcastToRoom(currentRoomId, {
            type: 'room-state',
            state: room
          });

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

          // Broadcast updated state
          broadcastToRoom(currentRoomId, {
            type: 'room-state',
            state: room
          });

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

// Track which room each client is in
const clientRooms = new WeakMap();

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

import { randomUUID } from 'crypto';

function generateId() {
  return randomUUID();
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

console.log(`WebSocket server running on port ${WS_PORT}`);
console.log(`HTTP server running on port ${PORT}`);

