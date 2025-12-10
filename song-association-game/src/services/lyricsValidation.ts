const escapeForRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface LyricsCheckResult {
  ok: boolean
  reason?: string
}

interface LyricsPayload {
  song: string
  artist: string
  word: string
}

async function tryFetchLyrics(
  artist: string,
  song: string
): Promise<{ lyrics: string } | null> {
  const endpoint = `https://api.lyrics.ovh/v1/${encodeURIComponent(
    artist
  )}/${encodeURIComponent(song)}`

  try {
    // Add timeout to prevent hanging
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout

    const response = await fetch(endpoint, {
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      return null
    }

    const payload = (await response.json()) as { lyrics?: string }
    return { lyrics: payload.lyrics ?? '' }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Timeout occurred
      return null
    }
    return null
  }
}

export async function verifyLyricsContainWord({
  song,
  artist,
  word
}: LyricsPayload): Promise<LyricsCheckResult> {
  const trimmedSong = song.trim()
  const trimmedArtist = artist.trim()

  if (!trimmedSong || !trimmedArtist) {
    return { ok: false, reason: 'Please provide both the song and artist.' }
  }

  // Fetch lyrics with exact artist and song name
  const result = await tryFetchLyrics(trimmedArtist, trimmedSong)

  if (!result || !result.lyrics) {
    return {
      ok: false,
      reason: 'Lyrics for that song were not found. Try another pick.'
    }
  }

  const lyrics = result.lyrics

  // Exact string matching - check if word exists in lyrics (case-insensitive, whole word)
  const target = escapeForRegex(word.toLowerCase())
  const regex = new RegExp(`\\b${target}\\b`, 'i')

  if (regex.test(lyrics)) {
    return { ok: true }
  }

  return {
    ok: false,
    reason: `Lyrics found but "${word}" was not detected.`
  }
}
