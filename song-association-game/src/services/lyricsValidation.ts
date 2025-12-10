import { normalizeArtistForAPI } from './fuzzyMatch'

const escapeForRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Capitalize words in a string (e.g., "taylor swift" -> "Taylor Swift")
 */
function capitalizeWords(str: string): string {
  return str
    .toLowerCase()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Try multiple artist name variations for API calls
 */
function getArtistVariations(artist: string): string[] {
  const trimmed = artist.trim()
  const variations = [trimmed]

  // Add capitalized version
  const capitalized = capitalizeWords(trimmed)
  if (capitalized !== trimmed) {
    variations.push(capitalized)
  }

  // Add normalized version (removes "The" prefix)
  const normalized = normalizeArtistForAPI(trimmed)
  if (normalized !== trimmed && normalized !== capitalized) {
    variations.push(normalized)
    variations.push(capitalizeWords(normalized))
  }

  // Remove duplicates
  return Array.from(new Set(variations))
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
  song: string
): Promise<{ lyrics: string } | null> {
  const endpoint = `https://api.lyrics.ovh/v1/${encodeURIComponent(
    artist
  )}/${encodeURIComponent(song)}`

  try {
    const response = await fetch(endpoint)

    if (!response.ok) {
      return null
    }

    const payload = (await response.json()) as { lyrics?: string }
    return { lyrics: payload.lyrics ?? '' }
  } catch {
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

  // Try multiple artist name variations
  const artistVariations = getArtistVariations(trimmedArtist)
  let lyrics: string | null = null

  for (const artistVar of artistVariations) {
    const result = await tryFetchLyrics(artistVar, trimmedSong)
    if (result) {
      lyrics = result.lyrics
      break
    }
  }

  if (!lyrics) {
    return {
      ok: false,
      reason: 'Lyrics for that song were not found. Try another pick.'
    }
  }

  // Check if word is in lyrics
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
