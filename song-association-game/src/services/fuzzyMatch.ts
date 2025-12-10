/**
 * Fuzzy string matching for artist names with typo tolerance
 */

// Common prefixes/suffixes to normalize
const ARTIST_PREFIXES = ['the', 'a', 'an']
const ARTIST_SUFFIXES = ['band', 'group']

/**
 * Normalize a string for comparison
 */
function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Normalize whitespace
}

/**
 * Remove common artist prefixes/suffixes
 */
function removeCommonPrefixesSuffixes(str: string): string {
  let normalized = normalizeString(str)
  
  // Remove "the" prefix
  for (const prefix of ARTIST_PREFIXES) {
    if (normalized.startsWith(prefix + ' ')) {
      normalized = normalized.slice(prefix.length + 1)
    }
  }
  
  // Remove common suffixes
  for (const suffix of ARTIST_SUFFIXES) {
    if (normalized.endsWith(' ' + suffix)) {
      normalized = normalized.slice(0, -(suffix.length + 1))
    }
  }
  
  return normalized.trim()
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length
  const len2 = str2.length
  const matrix: number[][] = []

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i]
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // deletion
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j - 1] + 1 // substitution
        )
      }
    }
  }

  return matrix[len1][len2]
}

/**
 * Check if two artist names match with typo tolerance
 * Returns true if they're similar enough (allowing for small typos)
 */
export function fuzzyMatchArtist(input: string, target: string): boolean {
  const normalizedInput = removeCommonPrefixesSuffixes(input)
  const normalizedTarget = removeCommonPrefixesSuffixes(target)

  // Exact match after normalization
  if (normalizedInput === normalizedTarget) {
    return true
  }

  // Check if one contains the other (handles "Beatles" vs "The Beatles")
  if (normalizedInput.includes(normalizedTarget) || normalizedTarget.includes(normalizedInput)) {
    return true
  }

  // Calculate edit distance
  const distance = levenshteinDistance(normalizedInput, normalizedTarget)
  const maxLength = Math.max(normalizedInput.length, normalizedTarget.length)
  
  // Allow up to 2 character differences or 20% error rate, whichever is more lenient
  const maxAllowedDistance = Math.max(2, Math.floor(maxLength * 0.2))
  
  return distance <= maxAllowedDistance
}

/**
 * Normalize artist name for API calls (removes "The" prefix for better API matching)
 */
export function normalizeArtistForAPI(artist: string): string {
  const normalized = normalizeString(artist)
  
  // Remove "the" prefix for API calls
  if (normalized.startsWith('the ')) {
    return normalized.slice(4)
  }
  
  return normalized
}

