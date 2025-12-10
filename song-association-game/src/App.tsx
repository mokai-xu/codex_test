import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { WORD_POOL } from './data/wordPool'
import { verifyLyricsContainWord } from './services/lyricsValidation'

const ROUND_TOTAL = 10
const DEFAULT_TIMER = 20

const createId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 9)

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
  const [phase, setPhase] = useState<Phase>('lobby')
  const [roomId, setRoomId] = useState<string>('')
  const [joinRoomId, setJoinRoomId] = useState<string>('')
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayer[]>([])
  const [roster, setRoster] = useState<LobbyPlayer[]>([])
  const [players, setPlayers] = useState<Player[]>([])
  const [roundDuration, setRoundDuration] = useState(DEFAULT_TIMER)
  const [roundWords, setRoundWords] = useState<string[]>([])
  const [currentRound, setCurrentRound] = useState(0)
  const [history, setHistory] = useState<RoundResult[]>(emptySubmissionHistory)

  const activeWord = roundWords[currentRound] ?? ''
  const gameMaster = roster[0] ?? null
  const canStartGame = lobbyPlayers.length > 0
  const rosterKey = useMemo(
    () => roster.map((player) => player.id).join('-'),
    [roster]
  )
  const roundInstanceKey = useMemo(
    () => `${currentRound}-${roundDuration}-${rosterKey}`,
    [currentRound, roundDuration, rosterKey]
  )

  const startGameWithRoster = useCallback((selectedRoster: LobbyPlayer[]) => {
    if (!selectedRoster.length) {
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

    setRoster(freshRoster)
    setPlayers(seededPlayers)
    setRoundWords(pickWords(WORD_POOL, ROUND_TOTAL))
    setCurrentRound(0)
    setHistory(emptySubmissionHistory)
    setPhase('playing')
  }, [])

  const advanceRound = useCallback(() => {
    setCurrentRound((prev) => {
      const nextIndex = prev + 1

      if (nextIndex >= roundWords.length) {
        setPhase('leaderboard')
        return prev
      }

      return nextIndex
    })
  }, [roundWords, setPhase])

  const handleRoundWin = useCallback(
    ({ playerId, word, song, artist }: RoundSuccessPayload) => {
      setPlayers((prev) =>
        prev.map((player) =>
          player.id === playerId
            ? { ...player, score: player.score + 1 }
            : player
        )
      )

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

      advanceRound()
    },
    [advanceRound]
  )

  const handleRoundTimeout = useCallback(
    (word: string) => {
      setHistory((prev) => [
        ...prev,
        {
          word,
          outcome: 'timeout'
        }
      ])

      advanceRound()
    },
    [advanceRound]
  )

  const handleRoundSkip = useCallback(
    (word: string) => {
      setHistory((prev) => [
        ...prev,
        {
          word,
          outcome: 'skipped'
        }
      ])

      advanceRound()
    },
    [advanceRound]
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
      return updated
    })
  }, [currentRound, history])

  const handleCreateRoom = useCallback(() => {
    const newRoomId = createRoomId()
    setRoomId(newRoomId)
    // Update URL with room ID
    const url = new URL(window.location.href)
    url.searchParams.set('room', newRoomId)
    window.history.pushState({}, '', url.toString())
  }, [])

  const handleJoinRoom = useCallback(() => {
    const trimmed = joinRoomId.trim().toUpperCase()
    if (trimmed.length === 6) {
      setRoomId(trimmed)
      const url = new URL(window.location.href)
      url.searchParams.set('room', trimmed)
      window.history.pushState({}, '', url.toString())
      setJoinRoomId('')
    }
  }, [joinRoomId])

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
      setRoomId(roomParam.toUpperCase())
    }
  }, [])

  const handleAddPlayer = (name: string) => {
    const trimmed = name.trim()

    if (!trimmed) {
      return
    }

    setLobbyPlayers((prev) => [...prev, { id: createId(), name: trimmed }])
  }

  const handleRemovePlayer = (playerId: string) => {
    setLobbyPlayers((prev) => prev.filter((player) => player.id !== playerId))
  }

  const handleStartGame = () => {
    startGameWithRoster(lobbyPlayers)
  }

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
          timer={roundDuration}
          roomId={roomId}
          joinRoomId={joinRoomId}
          onAddPlayer={handleAddPlayer}
          onRemovePlayer={handleRemovePlayer}
          onTimerChange={setRoundDuration}
          onStart={handleStartGame}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          onJoinRoomIdChange={setJoinRoomId}
          onCopyRoomId={handleCopyRoomId}
          canStart={canStartGame}
        />
      )}

      {phase === 'playing' && players.length > 0 && activeWord && (
        <>
          <Scoreboard players={players} />
          <GameRound
            key={roundInstanceKey}
            roster={roster}
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
  timer: number
  roomId: string
  joinRoomId: string
  canStart: boolean
  onAddPlayer: (name: string) => void
  onRemovePlayer: (playerId: string) => void
  onTimerChange: (timer: number) => void
  onStart: () => void
  onCreateRoom: () => void
  onJoinRoom: () => void
  onJoinRoomIdChange: (id: string) => void
  onCopyRoomId: () => void
}

const Lobby = ({
  players,
  timer,
  roomId,
  joinRoomId,
  canStart,
  onAddPlayer,
  onRemovePlayer,
  onTimerChange,
  onStart,
  onCreateRoom,
  onJoinRoom,
  onJoinRoomIdChange,
  onCopyRoomId
}: LobbyProps) => {
  const [nameInput, setNameInput] = useState('')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onAddPlayer(nameInput)
    setNameInput('')
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

      <form className="player-form" onSubmit={handleSubmit}>
        <div className="input-group">
          <label htmlFor="player-name">Add player</label>
          <div className="stacked-input">
            <input
              id="player-name"
              type="text"
              placeholder="Type a name"
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
            />
            <button type="submit" className="ghost-button">
              Add
            </button>
          </div>
        </div>
      </form>

      <ul className="player-chips">
        {players.map((player) => (
          <li key={player.id}>
            <span>{player.name}</span>
            <button
              type="button"
              onClick={() => onRemovePlayer(player.id)}
              aria-label={`Remove ${player.name}`}
            >
              ×
            </button>
          </li>
        ))}
        {!players.length && (
          <li className="placeholder">No players yet — add one to begin.</li>
        )}
      </ul>

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
  roster: LobbyPlayer[]
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

const createSubmissionState = (players: LobbyPlayer[]) =>
  players.reduce<Record<string, SubmissionState>>((state, player) => {
    state[player.id] = {
      song: '',
      artist: '',
      status: 'idle'
    }
    return state
  }, {})

const GameRound = ({
  roster,
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
  const [submissions, setSubmissions] = useState<Record<string, SubmissionState>>(
    () => createSubmissionState(roster)
  )
  const timeoutRef = useRef<number | null>(null)
  const timesUpIntervalRef = useRef<number | null>(null)

  // Reset timer and reshuffle when round changes
  useEffect(() => {
    setTimeLeft(duration)
    setRoundComplete(false)
    setShowTimesUp(false)
    setTimesUpLeft(0)
    setReshuffleUsed(false)
  }, [roundIndex, duration])

  const percentLeft = (timeLeft / duration) * 100

  useEffect(() => {
    if (roundComplete || timeLeft <= 0) {
      return
    }

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
                onTimeout(word)
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
      }
    }
  }, [roundComplete, timeLeft, onTimeout, word])

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
    playerId: string,
    field: 'song' | 'artist',
    value: string
  ) => {
    setSubmissions((prev) => ({
      ...prev,
      [playerId]: {
        ...prev[playerId],
        [field]: value
      }
    }))
  }

  const handleSubmit = async (playerId: string) => {
    if (roundComplete) {
      return
    }

    const submission = submissions[playerId]
    const { song, artist } = submission

    if (!song.trim() || !artist.trim()) {
      setSubmissions((prev) => ({
        ...prev,
        [playerId]: {
          ...prev[playerId],
          status: 'error',
          message: 'Enter both song and artist.'
        }
      }))
      return
    }

    setSubmissions((prev) => ({
      ...prev,
      [playerId]: {
        ...prev[playerId],
        status: 'validating',
        message: 'Checking lyrics...'
      }
    }))

    const result = await verifyLyricsContainWord({ song, artist, word })

    if (result.ok) {
      setSubmissions((prev) => ({
        ...prev,
        [playerId]: {
          ...prev[playerId],
          status: 'success',
          message: 'Word found!'
        }
      }))
      setRoundComplete(true)
      onSuccess({ playerId, word, song, artist })
      return
    }

    setSubmissions((prev) => ({
      ...prev,
      [playerId]: {
        ...prev[playerId],
        status: 'error',
        message: result.reason ?? 'No luck this time.'
      }
    }))
  }

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

      <div className="player-grid">
        {roster.map((player) => {
          const submission = submissions[player.id]
          const disabled =
            roundComplete || submission.status === 'success' || timeLeft <= 0

          return (
            <article key={player.id} className="player-card">
              <header>
                <span>{player.name}</span>
                <small>Playing to {totalRounds} words</small>
              </header>

              <label>
                Song title
                <input
                  type="text"
                  value={submission.song}
                  placeholder="e.g. Electric Feel"
                  disabled={disabled}
                  onChange={(event) =>
                    handleSubmissionChange(player.id, 'song', event.target.value)
                  }
                />
              </label>

              <label>
                Artist
                <input
                  type="text"
                  value={submission.artist}
                  placeholder="e.g. MGMT"
                  disabled={disabled}
                  onChange={(event) =>
                    handleSubmissionChange(
                      player.id,
                      'artist',
                      event.target.value
                    )
                  }
                />
              </label>

              <button
                type="button"
                className="primary-button subtle"
                disabled={disabled || submission.status === 'validating'}
                onClick={() => handleSubmit(player.id)}
              >
                {submission.status === 'validating' ? 'Checking…' : 'Submit'}
              </button>

              {submission.message && (
                <p className={`status ${submission.status}`}>
                  {submission.message}
                </p>
              )}
            </article>
          )
        })}
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
