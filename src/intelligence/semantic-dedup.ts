/**
 * 3-tier semantic deduplication engine with Porter stemmer.
 * Pure functions, no DB dependency. Non-throwing pattern.
 * @see Architecture Section 6.3
 */

/**
 * Stop words filtered before Jaccard keyword extraction.
 * @see Architecture Section 6.3
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'these',
  'those', 'i', 'we', 'you', 'he', 'she', 'they',
]);

/**
 * Dedup-specific normalization per Architecture 6.3:
 * Strips punctuation, lowercases, collapses whitespace.
 * Separate from text-utils normalize (which preserves punctuation).
 */
export function normalizeForDedup(text: string): string {
  try {
    if (!text) return '';
    return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// --- Porter Stemmer ---

/** Check if char is a consonant in context of the word */
function isConsonant(word: string, i: number): boolean {
  const c = word[i];
  if ('aeiou'.includes(c)) return false;
  if (c === 'y') return i === 0 || !isConsonant(word, i - 1);
  return true;
}

/** Measure: number of VC sequences in the stem */
function measure(stem: string): number {
  let m = 0;
  let i = 0;
  const len = stem.length;
  // Skip leading consonants
  while (i < len && isConsonant(stem, i)) i++;
  while (i < len) {
    // Count vowel sequence
    while (i < len && !isConsonant(stem, i)) i++;
    if (i >= len) break;
    m++;
    // Count consonant sequence
    while (i < len && isConsonant(stem, i)) i++;
  }
  return m;
}

/** Does stem contain a vowel? */
function hasVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i++) {
    if (!isConsonant(stem, i)) return true;
  }
  return false;
}

/** Does stem end with a double consonant? */
function endsDoubleConsonant(stem: string): boolean {
  const len = stem.length;
  if (len < 2) return false;
  return stem[len - 1] === stem[len - 2] && isConsonant(stem, len - 1);
}

/** Does stem end with CVC where last C is not w, x, or y? */
function endsCVC(stem: string): boolean {
  const len = stem.length;
  if (len < 3) return false;
  return (
    isConsonant(stem, len - 1) &&
    !isConsonant(stem, len - 2) &&
    isConsonant(stem, len - 3) &&
    !'wxy'.includes(stem[len - 1])
  );
}

/** Replace suffix if stem matches condition */
function replaceSuffix(
  word: string,
  suffix: string,
  replacement: string,
  condition?: (stem: string) => boolean
): string | null {
  if (!word.endsWith(suffix)) return null;
  const stem = word.slice(0, -suffix.length);
  if (condition && !condition(stem)) return null;
  return stem + replacement;
}

/**
 * Minimal Porter stemmer (~50 lines of core logic).
 * Reduces words to stems for keyword matching.
 * Non-throwing (returns input word on error).
 */
export function porterStem(word: string): string {
  try {
    if (!word || word.length <= 2) return word;

    let w = word.toLowerCase();

    // Step 1a
    if (w.endsWith('sses')) {
      w = w.slice(0, -2);
    } else if (w.endsWith('ies')) {
      w = w.slice(0, -2);
    } else if (!w.endsWith('ss') && w.endsWith('s')) {
      w = w.slice(0, -1);
    }

    // Step 1b
    let step1bFlag = false;
    if (w.endsWith('eed')) {
      const stem = w.slice(0, -3);
      if (measure(stem) > 0) w = stem + 'ee';
    } else if (w.endsWith('ed')) {
      const stem = w.slice(0, -2);
      if (hasVowel(stem)) {
        w = stem;
        step1bFlag = true;
      }
    } else if (w.endsWith('ing')) {
      const stem = w.slice(0, -3);
      if (hasVowel(stem)) {
        w = stem;
        step1bFlag = true;
      }
    }

    if (step1bFlag) {
      if (w.endsWith('at')) w += 'e';
      else if (w.endsWith('bl')) w += 'e';
      else if (w.endsWith('iz')) w += 'e';
      else if (endsDoubleConsonant(w) && !w.endsWith('ll') && !w.endsWith('ss') && !w.endsWith('zz')) {
        w = w.slice(0, -1);
      } else if (measure(w) === 1 && endsCVC(w)) {
        w += 'e';
      }
    }

    // Step 2
    const step2Map: [string, string][] = [
      ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
      ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
      ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
      ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
      ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
    ];
    for (const [suffix, replacement] of step2Map) {
      const result = replaceSuffix(w, suffix, replacement, (stem) => measure(stem) > 0);
      if (result !== null) { w = result; break; }
    }

    // Step 3
    const step3Map: [string, string][] = [
      ['icate', 'ic'], ['ative', ''], ['alize', 'al'],
      ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', ''],
    ];
    for (const [suffix, replacement] of step3Map) {
      const result = replaceSuffix(w, suffix, replacement, (stem) => measure(stem) > 0);
      if (result !== null) { w = result; break; }
    }

    // Step 5a: Remove trailing e
    if (w.endsWith('e')) {
      const stem = w.slice(0, -1);
      const m = measure(stem);
      if (m > 1 || (m === 1 && !endsCVC(stem))) {
        w = stem;
      }
    }

    // Step 5b: Remove trailing ll -> l
    if (w.endsWith('ll') && measure(w.slice(0, -1)) > 1) {
      w = w.slice(0, -1);
    }

    return w;
  } catch {
    return word;
  }
}

/**
 * Extract stemmed keywords from text.
 * Normalizes, filters stop words, stems, deduplicates.
 */
export function extractKeywords(text: string): string[] {
  try {
    if (!text) return [];
    const normalized = normalizeForDedup(text);
    if (!normalized) return [];
    const words = normalized.split(' ').filter((w) => w.length > 0 && !STOP_WORDS.has(w));
    const stemmed = words.map(porterStem);
    return [...new Set(stemmed)];
  } catch {
    return [];
  }
}

/**
 * Jaccard similarity on stemmed keyword sets.
 * Returns intersection.size / union.size (0 if union is empty).
 */
export function keywordJaccard(a: string, b: string): number {
  try {
    const setA = new Set(extractKeywords(a));
    const setB = new Set(extractKeywords(b));
    if (setA.size === 0 && setB.size === 0) return 0;

    const intersection = new Set([...setA].filter((w) => setB.has(w)));
    const union = new Set([...setA, ...setB]);

    return intersection.size / union.size;
  } catch {
    return 0;
  }
}

/**
 * Returns true if candidate is a duplicate of existing (any tier matches).
 * Tier 1: normalized exact match
 * Tier 2: keyword Jaccard >= 0.5
 * Tier 3: substring containment (after normalization)
 * Short-circuits on first match.
 */
export function isDuplicate(candidate: string, existing: string): boolean {
  try {
    const normA = normalizeForDedup(candidate);
    const normB = normalizeForDedup(existing);

    // Tier 1: normalized exact match
    if (normA === normB) return true;

    // Tier 2: keyword Jaccard >= 0.5
    if (keywordJaccard(candidate, existing) >= 0.5) return true;

    // Tier 3: substring containment (guard empty strings — "".includes("") is always true)
    if (normA && normB && (normA.includes(normB) || normB.includes(normA))) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Find matching existing entry for promotion workflows.
 * Returns first match, or null if none.
 */
export function findDuplicate<T extends { content: string }>(
  candidate: string,
  existingItems: T[]
): T | null {
  try {
    if (!existingItems || existingItems.length === 0) return null;
    for (const item of existingItems) {
      if (isDuplicate(candidate, item.content)) return item;
    }
    return null;
  } catch {
    return null;
  }
}
