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

  const endpoint = `https://api.lyrics.ovh/v1/${encodeURIComponent(
    trimmedArtist
  )}/${encodeURIComponent(trimmedSong)}`

  try {
    const response = await fetch(endpoint)

    if (!response.ok) {
      return {
        ok: false,
        reason: 'Lyrics for that song were not found. Try another pick.'
      }
    }

    const payload = (await response.json()) as { lyrics?: string }
    const lyrics = payload.lyrics ?? ''
    const target = escapeForRegex(word.toLowerCase())
    const regex = new RegExp(`\\b${target}\\b`, 'i')

    if (regex.test(lyrics)) {
      return { ok: true }
    }

    return {
      ok: false,
      reason: `Lyrics found but "${word}" was not detected.`
    }
  } catch {
    return {
      ok: false,
      reason: 'Network issue while checking lyrics. Please try again.'
    }
  }
}
