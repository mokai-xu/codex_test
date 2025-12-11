const escapeForRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- Artist normalization helpers ----
const stripLeadingThe = (value: string) =>
  value.replace(/^(the|a|an)\s+/i, '').trim()

const toTitleCase = (value: string) =>
  value
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ''))
    .join(' ')

const buildArtistVariants = (artist: string): string[] => {
  const trimmed = artist.trim()
  const variants = [
    trimmed,
    toTitleCase(trimmed),
    stripLeadingThe(trimmed),
    toTitleCase(stripLeadingThe(trimmed))
  ]
  // Remove empty and dedupe
  return Array.from(new Set(variants.filter(Boolean)))
}

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
  song: string,
  timeoutMs: number
): Promise<{ lyrics: string } | null> {
  const endpoint = `https://api.lyrics.ovh/v1/${encodeURIComponent(
    artist
  )}/${encodeURIComponent(song)}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(endpoint, { signal: controller.signal })
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as { lyrics?: string }
    return { lyrics: payload.lyrics ?? '' }
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
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

  // Build a few fast variants for the artist name
  const variants = buildArtistVariants(trimmedArtist).slice(0, 3)

  // Try in parallel with a short timeout (2s each). Pick the first that returns lyrics.
  const attempts = variants.map((variant) =>
    tryFetchLyrics(variant, trimmedSong, 2000)
  )

  const settled = await Promise.allSettled(attempts)
  const firstLyrics =
    settled
      .map((result) =>
        result.status === 'fulfilled' ? result.value : null
      )
      .find((val) => val && val.lyrics)?.lyrics ?? null

  if (!firstLyrics) {
    return {
      ok: false,
      reason: 'Lyrics for that song were not found. Try another pick.'
    }
  }

  const lyrics = firstLyrics

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
