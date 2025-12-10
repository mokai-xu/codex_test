/**
 * WebSocket-based room synchronization service
 * Enables cross-device multiplayer
 */

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3002';

export interface RoomState {
  roomId: string
  players: Array<{ id: string; name: string; deviceId: string }>
  phase: 'lobby' | 'playing' | 'leaderboard'
  roundDuration: number
  roundWords: string[]
  currentRound: number
  playersWithScores: Array<{ id: string; name: string; score: number }>
  history: Array<{
    word: string
    outcome: 'success' | 'timeout' | 'skipped'
    winnerId?: string
    song?: string
    artist?: string
  }>
  gameMasterId: string | null
  lastUpdated: number
}

type MessageType =
  | 'join-room'
  | 'add-player'
  | 'remove-player'
  | 'update-room'
  | 'player-submission'
  | 'round-timeout'
  | 'round-skip'
  | 'room-state'
  | 'error'

interface WebSocketMessage {
  type: MessageType
  [key: string]: unknown
}

/**
 * Get or create a unique device ID for this browser/device
 */
export function getDeviceId(): string {
  const DEVICE_ID_KEY = 'song-game-device-id'
  let deviceId = localStorage.getItem(DEVICE_ID_KEY)
  if (!deviceId) {
    deviceId = createId()
    localStorage.setItem(DEVICE_ID_KEY, deviceId)
  }
  return deviceId
}

function createId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 15)
}

class WebSocketClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private listeners: Map<string, Set<(data: unknown) => void>> = new Map()
  private deviceId: string

  constructor() {
    this.deviceId = getDeviceId()
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(WS_URL)

        this.ws.onopen = () => {
          console.log('WebSocket connected')
          this.reconnectAttempts = 0
          resolve()
        }

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as WebSocketMessage
            this.handleMessage(message)
          } catch (error) {
            console.error('Error parsing message:', error)
          }
        }

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error)
          reject(error)
        }

        this.ws.onclose = () => {
          console.log('WebSocket disconnected')
          this.ws = null
          this.attemptReconnect()
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached')
      this.emit('connection-error', { message: 'Failed to reconnect' })
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)

    setTimeout(() => {
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`)
      this.connect().catch(() => {
        // Reconnection will be attempted again
      })
    }, delay)
  }

  private handleMessage(message: WebSocketMessage): void {
    if (message.type === 'room-state') {
      this.emit('room-state', message.state)
    } else if (message.type === 'error') {
      this.emit('error', message)
    }
  }

  send(message: WebSocketMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
      console.warn('WebSocket not connected, message not sent:', message)
    }
  }

  on(event: string, callback: (data: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback)
  }

  off(event: string, callback: (data: unknown) => void): void {
    this.listeners.get(event)?.delete(callback)
  }

  private emit(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach((callback) => {
      try {
        callback(data)
      } catch (error) {
        console.error('Error in event listener:', error)
      }
    })
  }

  joinRoom(roomId: string): void {
    this.send({
      type: 'join-room',
      roomId,
      deviceId: this.deviceId
    })
  }

  addPlayer(playerName: string): void {
    this.send({
      type: 'add-player',
      playerName,
      deviceId: this.deviceId
    })
  }

  removePlayer(): void {
    this.send({
      type: 'remove-player',
      deviceId: this.deviceId
    })
  }

  updateRoom(updates: Partial<Omit<RoomState, 'roomId' | 'lastUpdated'>>): void {
    this.send({
      type: 'update-room',
      updates,
      deviceId: this.deviceId
    })
  }

  submitPlayerAnswer(playerId: string, word: string, song: string, artist: string): void {
    this.send({
      type: 'player-submission',
      playerId,
      word,
      song,
      artist,
      deviceId: this.deviceId
    })
  }

  timeoutRound(word: string): void {
    this.send({
      type: 'round-timeout',
      word,
      deviceId: this.deviceId
    })
  }

  skipRound(word: string): void {
    this.send({
      type: 'round-skip',
      word,
      deviceId: this.deviceId
    })
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.listeners.clear()
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}

// Singleton instance
let wsClient: WebSocketClient | null = null

export function getWebSocketClient(): WebSocketClient {
  if (!wsClient) {
    wsClient = new WebSocketClient()
    wsClient.connect().catch((error) => {
      console.error('Failed to connect WebSocket:', error)
    })
  }
  return wsClient
}

/**
 * Watch room state changes via WebSocket
 */
export function watchRoomState(
  roomId: string,
  callback: (state: RoomState | null) => void
): () => void {
  const client = getWebSocketClient()
  
  // Ensure connected
  if (!client.isConnected()) {
    client.connect().then(() => {
      client.joinRoom(roomId)
    }).catch(console.error)
  } else {
    client.joinRoom(roomId)
  }

  // Set up listener
  const handleState = (data: unknown) => {
    const state = data as RoomState
    if (state && state.roomId === roomId) {
      callback(state)
    }
  }

  const handleError = (data: unknown) => {
    const error = data as { message?: string }
    console.error('WebSocket error:', error)
  }

  client.on('room-state', handleState)
  client.on('error', handleError)

  // Return cleanup function
  return () => {
    client.off('room-state', handleState)
    client.off('error', handleError)
  }
}

/**
 * Add player to room
 */
export function addPlayerToRoom(
  roomId: string,
  playerName: string,
  deviceId: string
): { id: string; name: string; deviceId: string } | null {
  const client = getWebSocketClient()
  
  if (!client.isConnected()) {
    // Queue the action
    client.connect().then(() => {
      client.joinRoom(roomId)
      client.addPlayer(playerName)
    }).catch(console.error)
    return null
  }

  client.joinRoom(roomId)
  client.addPlayer(playerName)
  
  // Return a placeholder - actual player will come from room-state event
  return { id: 'pending', name: playerName, deviceId }
}

/**
 * Remove player from room
 */
export function removePlayerFromRoom(_roomId: string, _deviceId: string): void {
  const client = getWebSocketClient()
  if (client.isConnected()) {
    client.removePlayer()
  }
}

/**
 * Update room state (game master only)
 */
export function updateRoomState(
  _roomId: string,
  updates: Partial<Omit<RoomState, 'roomId' | 'lastUpdated'>>
): void {
  const client = getWebSocketClient()
  if (client.isConnected()) {
    client.updateRoom(updates)
  }
}

/**
 * Submit player answer
 */
export function submitPlayerAnswer(
  _roomId: string,
  playerId: string,
  word: string,
  song: string,
  artist: string
): void {
  const client = getWebSocketClient()
  if (client.isConnected()) {
    client.submitPlayerAnswer(playerId, word, song, artist)
  }
}

/**
 * Timeout round (game master only)
 */
export function timeoutRound(_roomId: string, word: string): void {
  const client = getWebSocketClient()
  if (client.isConnected()) {
    client.timeoutRound(word)
  }
}

/**
 * Skip round (game master only)
 */
export function skipRound(_roomId: string, word: string): void {
  const client = getWebSocketClient()
  if (client.isConnected()) {
    client.skipRound(word)
  }
}

/**
 * Clear room (not needed with WebSocket, but kept for compatibility)
 */
export function clearRoom(_roomId: string): void {
  // Rooms are managed on the server
}

