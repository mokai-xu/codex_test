const escapeForRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Generate singular and plural forms of a word
function getWordVariants(word: string): string[] {
  const lower = word.toLowerCase().trim()
  if (!lower) return [word]
  
  const variants = new Set<string>([lower]) // Always include the original word
  
  // If word ends in 's', try the singular form (remove 's')
  if (lower.endsWith('s') && lower.length > 1) {
    // Handle words ending in -es (boxes -> box)
    if (lower.endsWith('es') && lower.length > 2) {
      variants.add(lower.slice(0, -2)) // Remove 'es'
    }
    // Handle words ending in -ies (cities -> city)
    else if (lower.endsWith('ies') && lower.length > 3) {
      variants.add(lower.slice(0, -3) + 'y') // Remove 'ies', add 'y'
    }
    // Handle words ending in -ves (leaves -> leaf, knives -> knife)
    else if (lower.endsWith('ves') && lower.length > 3) {
      variants.add(lower.slice(0, -3) + 'f') // Try -f form
      variants.add(lower.slice(0, -3) + 'fe') // Try -fe form
    }
    // Regular -s ending (cats -> cat)
    else if (!lower.endsWith('ss')) {
      variants.add(lower.slice(0, -1)) // Remove 's'
    }
  }
  
  // Generate plural forms from the original word
  // Regular plural: add 's'
  if (!lower.endsWith('s')) {
    variants.add(lower + 's')
  }
  
  // Words ending in -s, -x, -z, -ch, -sh -> add 'es'
  if (/[sxz]|[cs]h$/.test(lower) && !lower.endsWith('es')) {
    variants.add(lower + 'es')
  }
  
  // Words ending in -y (consonant before y) -> change to -ies
  if (lower.endsWith('y') && lower.length > 1) {
    const beforeY = lower.slice(0, -1)
    if (beforeY && !/[aeiou]$/.test(beforeY)) {
      variants.add(beforeY + 'ies')
    }
  }
  
  // Words ending in -f -> change to -ves
  if (lower.endsWith('f') && lower.length > 1) {
    variants.add(lower.slice(0, -1) + 'ves')
  }
  
  // Words ending in -fe -> change to -ves
  if (lower.endsWith('fe') && lower.length > 2) {
    variants.add(lower.slice(0, -2) + 'ves')
  }
  
  return Array.from(variants)
}

// Cache configuration
const CACHE_TTL = 10 * 60 * 1000 // 10 minutes
const CACHE_KEY_PREFIX = 'lyrics_cache_'
const MAX_CACHE_SIZE = 200 // Maximum cached entries

// In-memory cache for fast access
const lyricsCache = new Map<string, { lyrics: string; timestamp: number }>()

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

// Generate cache key from artist and song
function getCacheKey(artist: string, song: string): string {
  return `${artist.toLowerCase().trim()}|${song.toLowerCase().trim()}`
}

// Get cached lyrics from memory or localStorage
function getCachedLyrics(artist: string, song: string): string | null {
  const key = getCacheKey(artist, song)
  
  // Check in-memory cache first
  const cached = lyricsCache.get(key)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.lyrics
  }
  
  // Check localStorage
  try {
    const stored = localStorage.getItem(CACHE_KEY_PREFIX + key)
    if (stored) {
      const parsed = JSON.parse(stored) as { lyrics: string; timestamp: number }
      if (Date.now() - parsed.timestamp < CACHE_TTL) {
        // Restore to memory cache
        lyricsCache.set(key, parsed)
        return parsed.lyrics
      } else {
        // Expired, remove it
        localStorage.removeItem(CACHE_KEY_PREFIX + key)
      }
    }
  } catch (error) {
    // localStorage might be unavailable or full
    console.warn('Failed to read from localStorage cache:', error)
  }
  
  return null
}

// Store lyrics in both memory and localStorage
function setCachedLyrics(artist: string, song: string, lyrics: string): void {
  const key = getCacheKey(artist, song)
  const cacheEntry = { lyrics, timestamp: Date.now() }
  
  // Store in memory
  lyricsCache.set(key, cacheEntry)
  
  // Store in localStorage
  try {
    localStorage.setItem(CACHE_KEY_PREFIX + key, JSON.stringify(cacheEntry))
    
    // Clean up old localStorage entries if cache is too large
    if (lyricsCache.size > MAX_CACHE_SIZE) {
      cleanupCache()
    }
  } catch (error) {
    // localStorage might be full, just keep in-memory cache
    console.warn('Failed to write to localStorage cache:', error)
    cleanupCache()
  }
}

// Clean up expired cache entries
function cleanupCache(): void {
  const now = Date.now()
  const keysToDelete: string[] = []
  
  // Clean in-memory cache
  for (const [key, value] of lyricsCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      keysToDelete.push(key)
    }
  }
  
  keysToDelete.forEach((key) => {
    lyricsCache.delete(key)
    try {
      localStorage.removeItem(CACHE_KEY_PREFIX + key)
    } catch {
      // Ignore localStorage errors during cleanup
    }
  })
  
  // If still too large, remove oldest entries
  if (lyricsCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(lyricsCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
    
    const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE)
    toRemove.forEach(([key]) => {
      lyricsCache.delete(key)
      try {
        localStorage.removeItem(CACHE_KEY_PREFIX + key)
      } catch {
        // Ignore errors
      }
    })
  }
}

async function tryFetchLyrics(
  artist: string,
  song: string,
  timeoutMs: number = 1500
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

  // Check cache first (fast path)
  const cached = getCachedLyrics(trimmedArtist, trimmedSong)
  if (cached) {
    // Check for word with pluralization variants
    const wordVariants = getWordVariants(word)
    const patterns = wordVariants.map(variant => {
      const escaped = escapeForRegex(variant)
      return new RegExp(`\\b${escaped}\\b`, 'i')
    })
    
    // Check if any variant matches
    if (patterns.some(regex => regex.test(cached))) {
      return { ok: true }
    }
    
    return {
      ok: false,
      reason: `Lyrics found but "${word}" was not detected.`
    }
  }

  // Build artist variants (limit to 2 for speed)
  const variants = buildArtistVariants(trimmedArtist).slice(0, 2)

  // Try variants in parallel with shorter timeout (1.5s each)
  const attempts = variants.map((variant) =>
    tryFetchLyrics(variant, trimmedSong, 1500)
  )

  const settled = await Promise.allSettled(attempts)
  const firstResult = settled
    .map((result) =>
      result.status === 'fulfilled' ? result.value : null
    )
    .find((val) => val && val.lyrics)

  if (!firstResult || !firstResult.lyrics) {
    return {
      ok: false,
      reason: 'Lyrics for that song were not found. Try another pick.'
    }
  }

  const lyrics = firstResult.lyrics

  // Cache the result for future use
  setCachedLyrics(trimmedArtist, trimmedSong, lyrics)

  // Check if word exists with pluralization variants (case-insensitive, whole word)
  const wordVariants = getWordVariants(word)
  const patterns = wordVariants.map(variant => {
    const escaped = escapeForRegex(variant)
    return new RegExp(`\\b${escaped}\\b`, 'i')
  })

  // Check if any variant matches
  if (patterns.some(regex => regex.test(lyrics))) {
    return { ok: true }
  }

  return {
    ok: false,
    reason: `Lyrics found but "${word}" was not detected.`
  }
}
