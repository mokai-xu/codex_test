/**
 * Room synchronization service using localStorage
 * Syncs room state across multiple devices/tabs
 */

const ROOM_STORAGE_PREFIX = 'song-game-room-'
const DEVICE_ID_KEY = 'song-game-device-id'
const SYNC_INTERVAL = 500 // Poll every 500ms for better responsiveness

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

/**
 * Get or create a unique device ID for this browser/device
 */
export function getDeviceId(): string {
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

/**
 * Get room state from localStorage
 */
export function getRoomState(roomId: string): RoomState | null {
  try {
    const stored = localStorage.getItem(`${ROOM_STORAGE_PREFIX}${roomId}`)
    if (!stored) return null
    const state = JSON.parse(stored) as RoomState
    // Clean up stale rooms (older than 1 hour)
    if (Date.now() - state.lastUpdated > 3600000) {
      localStorage.removeItem(`${ROOM_STORAGE_PREFIX}${roomId}`)
      return null
    }
    return state
  } catch {
    return null
  }
}

/**
 * Save room state to localStorage
 */
export function saveRoomState(state: RoomState): void {
  try {
    const key = `${ROOM_STORAGE_PREFIX}${state.roomId}`
    const stateToSave = {
      ...state,
      lastUpdated: Date.now()
    }
    localStorage.setItem(key, JSON.stringify(stateToSave))
    
    // Dispatch custom event for same-tab listeners
    window.dispatchEvent(new CustomEvent('roomStateUpdated', { detail: { roomId: state.roomId } }))
  } catch (error) {
    console.error('Failed to save room state:', error)
  }
}

/**
 * Add or update a player in the room
 */
export function addPlayerToRoom(
  roomId: string,
  playerName: string,
  deviceId: string
): { id: string; name: string; deviceId: string } | null {
  const state = getRoomState(roomId)
  if (!state) {
    // Create new room
    const playerId = createId()
    const newState: RoomState = {
      roomId,
      players: [{ id: playerId, name: playerName, deviceId }],
      phase: 'lobby',
      roundDuration: 20,
      roundWords: [],
      currentRound: 0,
      playersWithScores: [],
      history: [],
      gameMasterId: playerId, // First player is game master
      lastUpdated: Date.now()
    }
    saveRoomState(newState)
    return { id: playerId, name: playerName, deviceId }
  }

  // Check if this device already has a player
  const existingPlayer = state.players.find((p) => p.deviceId === deviceId)
  if (existingPlayer) {
    // Update existing player name if needed
    if (existingPlayer.name !== playerName) {
      existingPlayer.name = playerName
      saveRoomState(state)
    }
    return existingPlayer
  }

  // Add new player
  const playerId = createId()
  const newPlayer = { id: playerId, name: playerName, deviceId }
  state.players.push(newPlayer)
  saveRoomState(state)
  return newPlayer
}

/**
 * Remove a player from the room (by device ID)
 */
export function removePlayerFromRoom(roomId: string, deviceId: string): void {
  const state = getRoomState(roomId)
  if (!state) return

  state.players = state.players.filter((p) => p.deviceId !== deviceId)
  
  // If game master left, assign new game master
  if (state.gameMasterId && !state.players.find((p) => p.id === state.gameMasterId)) {
    state.gameMasterId = state.players.length > 0 ? state.players[0].id : null
  }
  
  saveRoomState(state)
}

/**
 * Update room state (for game master actions)
 */
export function updateRoomState(
  roomId: string,
  updates: Partial<Omit<RoomState, 'roomId' | 'lastUpdated'>>
): void {
  const state = getRoomState(roomId)
  if (!state) return

  Object.assign(state, updates)
  saveRoomState(state)
}

/**
 * Set up a listener for room state changes
 */
export function watchRoomState(
  roomId: string,
  callback: (state: RoomState | null) => void
): () => void {
  let lastState: string | null = null

  const checkForChanges = () => {
    const currentState = getRoomState(roomId)
    // Create a normalized string for comparison (sort players for consistency)
    const normalizedState = currentState ? {
      ...currentState,
      players: [...currentState.players].sort((a, b) => a.id.localeCompare(b.id))
    } : null
    const currentStateString = normalizedState ? JSON.stringify(normalizedState) : null

    if (currentStateString !== lastState) {
      lastState = currentStateString
      callback(currentState)
    }
  }

  // Check immediately
  checkForChanges()

  // Set up polling with shorter interval for better responsiveness
  const intervalId = setInterval(checkForChanges, SYNC_INTERVAL)

  // Also listen to storage events (for cross-tab sync)
  const handleStorage = (e: StorageEvent) => {
    if (e.key === `${ROOM_STORAGE_PREFIX}${roomId}`) {
      // Small delay to ensure the storage write has completed
      setTimeout(checkForChanges, 50)
    }
  }
  window.addEventListener('storage', handleStorage)

  // Also listen for custom events (for same-tab updates)
  const handleCustomStorage = () => {
    checkForChanges()
  }
  window.addEventListener('roomStateUpdated', handleCustomStorage)

  // Return cleanup function
  return () => {
    clearInterval(intervalId)
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener('roomStateUpdated', handleCustomStorage)
  }
}

/**
 * Clear room state
 */
export function clearRoom(roomId: string): void {
  localStorage.removeItem(`${ROOM_STORAGE_PREFIX}${roomId}`)
}

