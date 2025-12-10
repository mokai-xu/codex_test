import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { WORD_POOL } from './data/wordPool'
import { verifyLyricsContainWord } from './services/lyricsValidation'
import {
  getDeviceId,
  addPlayerToRoom,
  removePlayerFromRoom,
  updateRoomState,
  watchRoomState,
  clearRoom,
  submitPlayerAnswer,
  timeoutRound,
  skipRound
} from './services/websocketSync'

const ROUND_TOTAL = 10
const DEFAULT_TIMER = 20


const createRoomId = () => {
  // Generate a short, shareable room ID (e.g., "ABC123")
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // Exclude confusing chars
  let roomId = ''
  for (let i = 0; i < 6; i++) {
    roomId += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return roomId
}

type Phase = 'lobby' | 'playing' | 'leaderboard'

interface LobbyPlayer {
  id: string
  name: string
}

interface Player extends LobbyPlayer {
  score: number
}

interface RoundResult {
  word: string
  outcome: 'success' | 'timeout' | 'skipped'
  winnerId?: string
  song?: string
  artist?: string
}

interface RoundSuccessPayload {
  playerId: string
  word: string
  song: string
  artist: string
}

const pickWords = (pool: string[], count: number) => {
  const copy = [...pool]

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }

  return copy.slice(0, count)
}

const emptySubmissionHistory: RoundResult[] = []

function App() {
  const deviceId = useMemo(() => getDeviceId(), [])
  const [phase, setPhase] = useState<Phase>('lobby')
  const [roomId, setRoomId] = useState<string>('')
  const [joinRoomId, setJoinRoomId] = useState<string>('')
  const [myPlayer, setMyPlayer] = useState<LobbyPlayer | null>(null)
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayer[]>([])
  const [roomPlayers, setRoomPlayers] = useState<Array<{ id: string; name: string; deviceId: string }>>([])
  const [roster, setRoster] = useState<LobbyPlayer[]>([])
  const [players, setPlayers] = useState<Player[]>([])
  const [roundDuration, setRoundDuration] = useState(DEFAULT_TIMER)
  const [roundWords, setRoundWords] = useState<string[]>([])
  const [currentRound, setCurrentRound] = useState(0)
  const [history, setHistory] = useState<RoundResult[]>(emptySubmissionHistory)
  const [playerNameInput, setPlayerNameInput] = useState<string>('')
  const [isGameMaster, setIsGameMaster] = useState(false)

  const activeWord = roundWords[currentRound] ?? ''
  const [gameMasterId, setGameMasterId] = useState<string | null>(null)
  
  // Get game master from room state using gameMasterId
  const gameMaster = useMemo(() => {
    if (!gameMasterId || roster.length === 0) return roster[0] ?? null
    return roster.find((p) => p.id === gameMasterId) || roster[0] || null
  }, [gameMasterId, roster])
  const rosterKey = useMemo(
    () => roster.map((player) => player.id).join('-'),
    [roster]
  )
  const roundInstanceKey = useMemo(
    () => `${currentRound}-${roundDuration}-${rosterKey}`,
    [currentRound, roundDuration, rosterKey]
  )

  const startGameWithRoster = useCallback((selectedRoster: LobbyPlayer[]) => {
    if (!selectedRoster.length || !roomId) {
      return
    }

    const freshRoster = selectedRoster.map((player) => ({
      id: player.id,
      name: player.name
    }))

    const seededPlayers = freshRoster.map((player) => ({
      ...player,
      score: 0
    }))

    const words = pickWords(WORD_POOL, ROUND_TOTAL)

    // Update local state optimistically
    setRoster(freshRoster)
    setPlayers(seededPlayers)
    setRoundWords(words)
    setCurrentRound(0)
    setHistory(emptySubmissionHistory)
    setPhase('playing')

    // Sync to room state via WebSocket (game master only)
    if (myPlayer && roomId) {
      // Use roomPlayers which has deviceId
      const playersWithDeviceId = selectedRoster.map((p) => {
        const roomPlayer = roomPlayers.find((rp) => rp.id === p.id)
        return {
          id: p.id,
          name: p.name,
          deviceId: roomPlayer?.deviceId || ''
        }
      }).filter((p) => p.deviceId) // Only include players with deviceId

      updateRoomState(roomId, {
        players: playersWithDeviceId,
        roundDuration,
        phase: 'playing',
        roundWords: words,
        currentRound: 0,
        playersWithScores: seededPlayers,
        history: emptySubmissionHistory,
        gameMasterId: myPlayer.id
      })
    }
  }, [roomId, myPlayer, roundDuration, roomPlayers])

  // Round advancement is now handled by the server automatically

  const handleRoundWin = useCallback(
    ({ playerId, word, song, artist }: RoundSuccessPayload) => {
      // Submit to server via WebSocket
      if (roomId) {
        submitPlayerAnswer(roomId, playerId, word, song, artist)
      }

      // Local state will be updated via room-state event
      setHistory((prev) => [
        ...prev,
        {
          word,
          outcome: 'success',
          winnerId: playerId,
          song,
          artist
        }
      ])
    },
    [roomId]
  )

  const handleRoundTimeout = useCallback(
    (word: string) => {
      // Submit to server via WebSocket (game master only)
      if (roomId) {
        timeoutRound(roomId, word)
      }

      // Local state will be updated via room-state event
      setHistory((prev) => [
        ...prev,
        {
          word,
          outcome: 'timeout' as const
        }
      ])
    },
    [roomId]
  )

  const handleRoundSkip = useCallback(
    (word: string) => {
      // Submit to server via WebSocket (game master only)
      if (roomId) {
        skipRound(roomId, word)
      }

      // Local state will be updated via room-state event
      setHistory((prev) => [
        ...prev,
        {
          word,
          outcome: 'skipped' as const
        }
      ])
    },
    [roomId]
  )

  const handleReshuffleWord = useCallback(() => {
    setRoundWords((prev) => {
      if (!prev.length) {
        return prev
      }

      const used = new Set([
        ...history.map((entry) => entry.word),
        ...prev.slice(0, currentRound)
      ])

      const currentWord = prev[currentRound]
      used.delete(currentWord)

      const candidates = WORD_POOL.filter((word) => !used.has(word))
      if (!candidates.length) {
        return prev
      }

      const nextWord =
        candidates[Math.floor(Math.random() * candidates.length)]
      const updated = [...prev]
      updated[currentRound] = nextWord

      // Sync to room state via WebSocket
      if (roomId) {
        updateRoomState(roomId, {
          roundWords: updated
        })
      }

      return updated
    })
  }, [currentRound, history, roomId])

  const handleCreateRoom = useCallback(() => {
    const newRoomId = createRoomId()
    setRoomId(newRoomId)
    setMyPlayer(null)
    setLobbyPlayers([])
    // Update URL with room ID
    const url = new URL(window.location.href)
    url.searchParams.set('room', newRoomId)
    window.history.pushState({}, '', url.toString())
    // Clear any existing room state
    clearRoom(newRoomId)
  }, [])

  const handleJoinRoom = useCallback(() => {
    const trimmed = joinRoomId.trim().toUpperCase()
    if (trimmed.length === 6) {
      setRoomId(trimmed)
      setMyPlayer(null)
      setJoinRoomId('')
      const url = new URL(window.location.href)
      url.searchParams.set('room', trimmed)
      window.history.pushState({}, '', url.toString())
      // Room state will be loaded via WebSocket watchRoomState
    }
  }, [joinRoomId])

  const handleAddMyself = useCallback(() => {
    if (!roomId || !playerNameInput.trim()) return

    addPlayerToRoom(roomId, playerNameInput.trim(), deviceId)
    setPlayerNameInput('')
    // Player will be set when room-state event arrives
  }, [roomId, playerNameInput, deviceId])

  const handleRemoveMyself = useCallback(() => {
    if (!roomId) return
    removePlayerFromRoom(roomId, deviceId)
    setMyPlayer(null)
  }, [roomId, deviceId])

  const handleCopyRoomId = useCallback(() => {
    if (roomId) {
      navigator.clipboard.writeText(roomId)
    }
  }, [roomId])

  // Initialize room from URL on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const roomParam = urlParams.get('room')
    if (roomParam && roomParam.length === 6) {
      const upperRoomId = roomParam.toUpperCase()
      setRoomId(upperRoomId)
      // Room state will be loaded via WebSocket watchRoomState
    }
  }, [])

  // Sync room state across devices/tabs
  useEffect(() => {
    if (!roomId) return

    const unwatch = watchRoomState(roomId, (state) => {
      if (!state) {
        setLobbyPlayers([])
        setPhase('lobby')
        return
      }

      // Always update players list from room state
      const playersFromState = state.players.map((p) => ({ id: p.id, name: p.name }))
      setLobbyPlayers(playersFromState)
      setRoomPlayers(state.players) // Store full player data with deviceId
      
      setRoundDuration(state.roundDuration)
      setPhase(state.phase)
      setRoundWords(state.roundWords)
      setCurrentRound(state.currentRound)
      setHistory(state.history)
      setGameMasterId(state.gameMasterId)

      if (state.phase === 'playing') {
        // If playersWithScores exists, use it, otherwise create from players
        if (state.playersWithScores.length > 0) {
          setPlayers(state.playersWithScores)
        } else {
          // Initialize players with scores of 0
          setPlayers(state.players.map((p) => ({ id: p.id, name: p.name, score: 0 })))
        }
        setRoster(playersFromState)
      } else if (state.phase === 'leaderboard') {
        if (state.playersWithScores.length > 0) {
          setPlayers(state.playersWithScores)
        } else {
          setPlayers(state.players.map((p) => ({ id: p.id, name: p.name, score: 0 })))
        }
        setRoster(playersFromState)
      } else if (state.phase === 'lobby') {
        // In lobby, ensure roster is set to current players
        setRoster(playersFromState)
        setPlayers([])
      }

      // Update my player if it exists
      const myPlayerInRoom = state.players.find((p) => p.deviceId === deviceId)
      if (myPlayerInRoom) {
        setMyPlayer({ id: myPlayerInRoom.id, name: myPlayerInRoom.name })
        setIsGameMaster(state.gameMasterId === myPlayerInRoom.id)
      } else {
        // Only clear myPlayer if we're not in the process of adding ourselves
        // This prevents flickering when joining
        if (myPlayer && !playerNameInput.trim()) {
          setMyPlayer(null)
          setIsGameMaster(false)
        }
      }
    })

    return unwatch
  }, [roomId, deviceId, myPlayer, playerNameInput])


  const handleStartGame = () => {
    if (lobbyPlayers.length > 0) {
      startGameWithRoster(lobbyPlayers)
    }
  }

  const handleTimerChange = useCallback((timer: number) => {
    setRoundDuration(timer)
    // Sync to room state via WebSocket (game master only)
    if (roomId && myPlayer) {
      updateRoomState(roomId, {
        roundDuration: timer
      })
    }
  }, [roomId, myPlayer])

  const handleReplay = () => {
    if (!roster.length) {
      return
    }
    startGameWithRoster(roster)
  }

  const handleReturnToLobby = () => {
    setPhase('lobby')
    setPlayers([])
    setRoundWords([])
    setCurrentRound(0)
    setHistory(emptySubmissionHistory)
    if (roster.length) {
      setLobbyPlayers(roster)
    }
  }

  const sortedLeaders = useMemo(
    () => [...players].sort((a, b) => b.score - a.score),
    [players]
  )

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Song Association</p>
          <h1>Sing on the Spot</h1>
        </div>
        <p className="header-meta">
          {phase === 'playing'
            ? `Round ${currentRound + 1} of ${ROUND_TOTAL}`
            : `${ROUND_TOTAL} rounds · ${roundDuration}s timer`}
        </p>
      </header>

      {phase === 'lobby' && (
        <Lobby
          players={lobbyPlayers}
          myPlayer={myPlayer}
          playerNameInput={playerNameInput}
          timer={roundDuration}
          roomId={roomId}
          joinRoomId={joinRoomId}
          onAddMyself={handleAddMyself}
          onRemoveMyself={handleRemoveMyself}
          onPlayerNameInputChange={setPlayerNameInput}
          onTimerChange={handleTimerChange}
          onStart={handleStartGame}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          onJoinRoomIdChange={setJoinRoomId}
          onCopyRoomId={handleCopyRoomId}
          canStart={lobbyPlayers.length > 0 && myPlayer !== null}
          isGameMaster={isGameMaster}
        />
      )}

      {phase === 'playing' && roundWords.length > 0 && activeWord && myPlayer && (players.length > 0 || roster.length > 0) && (
        <>
          <Scoreboard players={players} />
          <GameRound
            key={roundInstanceKey}
            myPlayer={myPlayer}
            gameMaster={gameMaster}
            word={activeWord}
            roundIndex={currentRound}
            totalRounds={ROUND_TOTAL}
            duration={roundDuration}
            onSuccess={handleRoundWin}
            onTimeout={handleRoundTimeout}
            onSkip={handleRoundSkip}
            onReshuffle={handleReshuffleWord}
          />
        </>
      )}

      {phase === 'leaderboard' && (
        <Leaderboard
          players={sortedLeaders}
          history={history}
          onReplay={handleReplay}
          onBackToLobby={handleReturnToLobby}
        />
      )}
    </div>
  )
}

interface LobbyProps {
  players: LobbyPlayer[]
  myPlayer: LobbyPlayer | null
  playerNameInput: string
  timer: number
  roomId: string
  joinRoomId: string
  canStart: boolean
  isGameMaster: boolean
  onAddMyself: () => void
  onRemoveMyself: () => void
  onPlayerNameInputChange: (name: string) => void
  onTimerChange: (timer: number) => void
  onStart: () => void
  onCreateRoom: () => void
  onJoinRoom: () => void
  onJoinRoomIdChange: (id: string) => void
  onCopyRoomId: () => void
}

const Lobby = ({
  players,
  myPlayer,
  playerNameInput,
  timer,
  roomId,
  joinRoomId,
  canStart,
  isGameMaster,
  onAddMyself,
  onRemoveMyself,
  onPlayerNameInputChange,
  onTimerChange,
  onStart,
  onCreateRoom,
  onJoinRoom,
  onJoinRoomIdChange,
  onCopyRoomId
}: LobbyProps) => {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onAddMyself()
  }

  return (
    <section className="panel lobby">
      <div className="panel-heading">
        <h2>Lobby</h2>
        <p>Invite friends, set a timer, and start the 10-word challenge.</p>
      </div>

      <div className="room-section">
        <h3>Room</h3>
        {roomId ? (
          <div className="room-display">
            <div className="room-id-group">
              <label>Room ID</label>
              <div className="room-id-display">
                <code className="room-id">{roomId}</code>
                <button
                  type="button"
                  className="ghost-button small"
                  onClick={onCopyRoomId}
                >
                  Copy
                </button>
              </div>
              <p className="room-hint">Share this ID with friends to join your game</p>
            </div>
          </div>
        ) : (
          <div className="room-actions">
            <button
              type="button"
              className="primary-button"
              onClick={onCreateRoom}
            >
              Create Room
            </button>
            <div className="join-room-group">
              <label htmlFor="join-room">Join Room</label>
              <div className="stacked-input">
                <input
                  id="join-room"
                  type="text"
                  placeholder="Enter room ID"
                  value={joinRoomId}
                  onChange={(e) => onJoinRoomIdChange(e.target.value.toUpperCase())}
                  maxLength={6}
                  style={{ textTransform: 'uppercase' }}
                />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={onJoinRoom}
                  disabled={joinRoomId.length !== 6}
                >
                  Join
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {!myPlayer ? (
        <form className="player-form" onSubmit={handleSubmit}>
          <div className="input-group">
            <label htmlFor="player-name">Enter your name</label>
            <div className="stacked-input">
              <input
                id="player-name"
                type="text"
                placeholder="Type your name"
                value={playerNameInput}
                onChange={(event) => onPlayerNameInputChange(event.target.value)}
                maxLength={20}
              />
              <button type="submit" className="ghost-button" disabled={!playerNameInput.trim() || !roomId}>
                Join
              </button>
            </div>
            {!roomId && (
              <p className="room-hint" style={{ marginTop: '0.5rem' }}>
                Create or join a room first
              </p>
            )}
          </div>
        </form>
      ) : (
        <div className="my-player-section">
          <div className="input-group">
            <label>Your player</label>
            <div className="my-player-card">
              <span>{myPlayer.name}</span>
              <button
                type="button"
                className="ghost-button small"
                onClick={onRemoveMyself}
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="players-section">
        <h3>Players in room ({players.length})</h3>
        <ul className="player-chips">
          {players.map((player) => (
            <li key={player.id}>
              <span>{player.name}</span>
              {player.id === myPlayer?.id && <span className="you-badge">You</span>}
            </li>
          ))}
          {!players.length && (
            <li className="placeholder">No players in room yet</li>
          )}
        </ul>
      </div>

      {isGameMaster && (
        <>
          <div className="timer-control">
            <label htmlFor="round-timer">Round timer</label>
            <input
              id="round-timer"
              type="range"
              min={10}
              max={60}
              step={5}
              value={timer}
              onChange={(event) => onTimerChange(Number(event.target.value))}
            />
            <p className="timer-value">{timer} seconds per word</p>
          </div>

          <button
            type="button"
            className="primary-button"
            disabled={!canStart}
            onClick={onStart}
          >
            Start 10-round game
          </button>
        </>
      )}

      {!isGameMaster && canStart && (
        <p className="waiting-message">Waiting for game master to start the game...</p>
      )}
    </section>
  )
}

const Scoreboard = ({ players }: { players: Player[] }) => (
  <section className="panel scoreboard">
    <div className="panel-heading">
      <h2>Scoreboard</h2>
      <p>First singer to match the word wins the round.</p>
    </div>

    <ol>
      {players.map((player) => (
        <li key={player.id}>
          <span>{player.name}</span>
          <span className="score">{player.score}</span>
        </li>
      ))}
    </ol>
  </section>
)

interface GameRoundProps {
  myPlayer: LobbyPlayer
  gameMaster: LobbyPlayer | null
  word: string
  roundIndex: number
  totalRounds: number
  duration: number
  onSuccess: (payload: RoundSuccessPayload) => void
  onTimeout: (word: string) => void
  onSkip: (word: string) => void
  onReshuffle: () => void
}

type SubmissionStatus = 'idle' | 'validating' | 'success' | 'error'

interface SubmissionState {
  song: string
  artist: string
  status: SubmissionStatus
  message?: string
}


const GameRound = ({
  myPlayer,
  gameMaster,
  word,
  roundIndex,
  totalRounds,
  duration,
  onSuccess,
  onTimeout,
  onSkip,
  onReshuffle
}: GameRoundProps) => {
  const [timeLeft, setTimeLeft] = useState(() => duration)
  const [roundComplete, setRoundComplete] = useState(false)
  const [showTimesUp, setShowTimesUp] = useState(false)
  const [timesUpLeft, setTimesUpLeft] = useState(0)
  const [reshuffleUsed, setReshuffleUsed] = useState(false)
  const [submission, setSubmission] = useState<SubmissionState>({
    song: '',
    artist: '',
    status: 'idle'
  })
  const timeoutRef = useRef<number | null>(null)
  const timesUpIntervalRef = useRef<number | null>(null)

  // Reset timer and reshuffle when round changes
  useEffect(() => {
    // Clear any existing timers
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (timesUpIntervalRef.current) {
      window.clearInterval(timesUpIntervalRef.current)
      timesUpIntervalRef.current = null
    }
    
    // Reset state
    setTimeLeft(duration)
    setRoundComplete(false)
    setShowTimesUp(false)
    setTimesUpLeft(0)
    setReshuffleUsed(false)
  }, [roundIndex, duration, word])

  const percentLeft = (timeLeft / duration) * 100

  useEffect(() => {
    // Don't run timer if round is complete or time is already at 0
    if (roundComplete) {
      return
    }

    // If timeLeft is already 0 or less, trigger timeout immediately
    if (timeLeft <= 0) {
      setRoundComplete(true)
      setShowTimesUp(true)
      setTimesUpLeft(5)
      timesUpIntervalRef.current = window.setInterval(() => {
        setTimesUpLeft((left) => {
          if (left <= 1) {
            if (timesUpIntervalRef.current) {
              window.clearInterval(timesUpIntervalRef.current)
            }
            // Only game master should trigger timeout on server
            // Other clients will receive the update via room-state event
            if (gameMaster && myPlayer.id === gameMaster.id) {
              onTimeout(word)
            }
            return 0
          }
          return left - 1
        })
      }, 1000)
      return
    }

    // Set up the countdown timer
    timeoutRef.current = window.setTimeout(() => {
      setTimeLeft((prev) => {
        const newTime = prev - 1
        if (newTime <= 0) {
          setRoundComplete(true)
          setShowTimesUp(true)
          setTimesUpLeft(5)
          timesUpIntervalRef.current = window.setInterval(() => {
            setTimesUpLeft((left) => {
              if (left <= 1) {
                if (timesUpIntervalRef.current) {
                  window.clearInterval(timesUpIntervalRef.current)
                }
                // Only game master should trigger timeout on server
                // Other clients will receive the update via room-state event
                if (gameMaster && myPlayer.id === gameMaster.id) {
                  onTimeout(word)
                }
                return 0
              }
              return left - 1
            })
          }, 1000)
          return 0
        }

        return newTime
      })
    }, 1000)

    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [roundComplete, timeLeft, onTimeout, word, gameMaster, myPlayer])

  useEffect(
    () => () => {
      if (timesUpIntervalRef.current) {
        window.clearInterval(timesUpIntervalRef.current)
      }
    },
    []
  )

  const handleSkip = () => {
    if (roundComplete) {
      return
    }
    setRoundComplete(true)
    onSkip(word)
  }

  const handleReshuffle = () => {
    if (roundComplete || reshuffleUsed) {
      return
    }
    setReshuffleUsed(true)
    onReshuffle()
    // Timer continues - don't reset it
  }

  const handleSubmissionChange = (
    field: 'song' | 'artist',
    value: string
  ) => {
    setSubmission((prev) => ({
      ...prev,
      [field]: value
    }))
  }

  const handleSubmit = async () => {
    if (roundComplete) {
      return
    }

    const { song, artist } = submission

    if (!song.trim() || !artist.trim()) {
      setSubmission((prev) => ({
        ...prev,
        status: 'error',
        message: 'Enter both song and artist.'
      }))
      return
    }

    // Prevent multiple submissions
    if (submission.status === 'validating') {
      return
    }

    setSubmission((prev) => ({
      ...prev,
      status: 'validating',
      message: 'Checking lyrics...'
    }))

    try {
      const result = await verifyLyricsContainWord({ song, artist, word })

      if (result.ok) {
        setSubmission((prev) => ({
          ...prev,
          status: 'success',
          message: 'Word found!'
        }))
        setRoundComplete(true)
        onSuccess({ playerId: myPlayer.id, word, song, artist })
        return
      }

      setSubmission((prev) => ({
        ...prev,
        status: 'error',
        message: result.reason ?? 'No luck this time.'
      }))
    } catch (error) {
      console.error('Error checking lyrics:', error)
      setSubmission((prev) => ({
        ...prev,
        status: 'error',
        message: 'Network error. Please try again.'
      }))
    }
  }

  // Reset submission when round changes
  useEffect(() => {
    setSubmission({
      song: '',
      artist: '',
      status: 'idle'
    })
  }, [roundIndex, word])

  return (
    <section className="panel round">
      <div className="round-word">
        <div className="round-meta">
          <p>Round {roundIndex + 1}</p>
          {gameMaster && (
            <p className="gm-chip">Game Master: {gameMaster.name}</p>
          )}
        </div>
        <h2>{word}</h2>
        <div className="timer">
          <div className="timer-track">
            <span
              className="timer-thumb"
              style={{ width: `${Math.max(percentLeft, 0)}%` }}
            />
          </div>
          <span>{timeLeft}s remaining</span>
        </div>

        {showTimesUp && (
          <div className="times-up">
            <strong>Time’s up</strong>
            <span>Next round begins in {Math.max(timesUpLeft, 0)} seconds…</span>
          </div>
        )}

        {gameMaster && (
          <div className="gm-controls">
            <button
              type="button"
              className="ghost-button"
              disabled={roundComplete || reshuffleUsed}
              onClick={handleReshuffle}
            >
              {reshuffleUsed ? 'Reshuffle used' : 'Reshuffle word'}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={roundComplete}
              onClick={handleSkip}
            >
              Skip round
            </button>
          </div>
        )}
      </div>

      <div className="player-submission">
        <article className="player-card">
          <header>
            <span>{myPlayer.name}</span>
            <small>Round {roundIndex + 1} of {totalRounds}</small>
          </header>

          <label>
            Song title
            <input
              type="text"
              value={submission.song}
              placeholder="e.g. Electric Feel"
              disabled={roundComplete || submission.status === 'success' || timeLeft <= 0}
              onChange={(event) =>
                handleSubmissionChange('song', event.target.value)
              }
            />
          </label>

          <label>
            Artist
            <input
              type="text"
              value={submission.artist}
              placeholder="e.g. MGMT"
              disabled={roundComplete || submission.status === 'success' || timeLeft <= 0}
              onChange={(event) =>
                handleSubmissionChange('artist', event.target.value)
              }
            />
          </label>

          <button
            type="button"
            className="primary-button subtle"
            disabled={
              roundComplete ||
              submission.status === 'success' ||
              submission.status === 'validating' ||
              timeLeft <= 0
            }
            onClick={handleSubmit}
          >
            {submission.status === 'validating' ? 'Checking…' : 'Submit'}
          </button>

          {submission.message && (
            <p className={`status ${submission.status}`}>
              {submission.message}
            </p>
          )}
        </article>
      </div>
    </section>
  )
}

interface LeaderboardProps {
  players: Player[]
  history: RoundResult[]
  onReplay: () => void
  onBackToLobby: () => void
}

const Leaderboard = ({
  players,
  history,
  onReplay,
  onBackToLobby
}: LeaderboardProps) => (
  <section className="panel leaderboard">
    <div className="panel-heading">
      <p className="eyebrow">Game complete</p>
      <h2>Leaderboard</h2>
      <p>Share the crown or run it back.</p>
    </div>

    <ol>
      {players.map((player, index) => (
        <li key={player.id}>
          <span>
            <strong>{index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '•'}</strong>{' '}
            {player.name}
          </span>
          <span className="score">{player.score}</span>
        </li>
      ))}
    </ol>

    <div className="history">
      <h3>Round recap</h3>
      <ul>
        {history.map((entry, index) => (
          <li key={`${entry.word}-${index}`}>
            <span className="word-chip">{entry.word}</span>
            {entry.outcome === 'success' && entry.winnerId ? (
              <span>
                claimed by{' '}
                <strong>
                  {players.find((p) => p.id === entry.winnerId)?.name ??
                    'Unknown'}
                </strong>{' '}
                with “{entry.song}” — {entry.artist}
              </span>
            ) : entry.outcome === 'skipped' ? (
              <span>Skipped by Game Master.</span>
            ) : (
              <span>No match — timer expired.</span>
            )}
          </li>
        ))}
      </ul>
    </div>

    <div className="action-row">
      <button type="button" className="ghost-button" onClick={onBackToLobby}>
        Back to lobby
      </button>
      <button type="button" className="primary-button" onClick={onReplay}>
        Play again
      </button>
    </div>
  </section>
)

export default App

