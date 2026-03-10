/**
 * Three-layer redaction engine with path sanitization.
 * Pure functions, no DB dependency. Non-throwing pattern.
 * @see Architecture Section 5.4 — three-layer redaction
 */

// --- Shannon Entropy ---

/**
 * Standard Shannon entropy calculation on character frequencies.
 * Returns bits per character.
 */
export function shannonEntropy(s: string): number {
  if (!s || s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  const len = s.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

// --- Layer 1: Pattern-based secrets ---

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // JWT (must be before base64 to catch first)
  [/eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}[a-zA-Z0-9._-]*/g, '[REDACTED_SECRET]'],
  // AWS access key
  [/AKIA[A-Z0-9]{16}/g, '[REDACTED_SECRET]'],
  // AWS secret
  [/aws_secret_access_key\s*=\s*\S+/g, '[REDACTED_SECRET]'],
  // GitHub PAT
  [/ghp_[a-zA-Z0-9]{36}/g, '[REDACTED_SECRET]'],
  [/github_pat_[a-zA-Z0-9_]{20,}/g, '[REDACTED_SECRET]'],
  // Bearer tokens
  [/Bearer [a-zA-Z0-9_-]{20,}/g, '[REDACTED_SECRET]'],
  // Generic API keys (sk-, key-)
  [/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED_SECRET]'],
  [/key-[a-zA-Z0-9]{20,}/g, '[REDACTED_SECRET]'],
  // Base64 strings > 32 chars (exclude pure hex strings — those are hashes, not secrets)
  [/[A-Za-z0-9+/]{32,}={0,2}/g, '__BASE64_CANDIDATE__'],
];

const HEX_ONLY = /^[a-fA-F0-9]+$/;

function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    if (replacement === '__BASE64_CANDIDATE__') {
      // Base64 candidate: skip pure hex strings (those are hashes, not secrets)
      result = result.replace(pattern, (match) => {
        if (HEX_ONLY.test(match)) return match;
        return '[REDACTED_SECRET]';
      });
    } else {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

// --- Layer 2: PII patterns ---

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_US_PATTERN = /(?<![a-fA-F0-9-])\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?![0-9a-fA-F-])/g;
const SSN_PATTERN = /(?<![a-fA-F0-9-])\d{3}-\d{2}-\d{4}(?![0-9a-fA-F-])/g;
const CREDIT_CARD_PATTERN = /(?<![0-9a-fA-F-])\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![0-9a-fA-F-])/g;
const IP_PATTERN = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function isPrivateOrLoopbackIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  // 10.x.x.x
  if (a === 10) return true;
  // 172.16-31.x.x
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.x.x
  if (a === 192 && b === 168) return true;
  // 127.x.x.x (loopback)
  if (a === 127) return true;
  return false;
}

function redactPII(text: string): string {
  let result = text;

  // SSN before phone (SSN is more specific: 3-2-4 pattern)
  SSN_PATTERN.lastIndex = 0;
  result = result.replace(SSN_PATTERN, '[REDACTED_PII]');

  // Credit cards
  CREDIT_CARD_PATTERN.lastIndex = 0;
  result = result.replace(CREDIT_CARD_PATTERN, '[REDACTED_PII]');

  // Emails
  EMAIL_PATTERN.lastIndex = 0;
  result = result.replace(EMAIL_PATTERN, '[REDACTED_PII]');

  // Phone (US format) — after SSN to avoid double-matching
  PHONE_US_PATTERN.lastIndex = 0;
  result = result.replace(PHONE_US_PATTERN, '[REDACTED_PII]');

  // IP addresses (only public)
  IP_PATTERN.lastIndex = 0;
  result = result.replace(IP_PATTERN, (match) => {
    return isPrivateOrLoopbackIP(match) ? match : '[REDACTED_PII]';
  });

  return result;
}

// --- Layer 3: Entropy-based ---

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_PATTERN = /^[a-fA-F0-9]+$/;

function isAllowlisted(token: string): boolean {
  // File paths
  if (/^[/.]/.test(token) || /^[A-Z]:[/\\]/.test(token)) return true;
  // URLs
  if (/^https?:\/\//.test(token)) return true;
  // Hex strings (all hex chars)
  if (HEX_PATTERN.test(token)) return true;
  // UUIDs
  if (UUID_PATTERN.test(token)) return true;
  // node_modules paths
  if (token.includes('node_modules/') || token.includes('node_modules\\')) return true;
  // Qualified names (identifiers with dots/underscores that look like package names)
  if (/^[a-zA-Z@][a-zA-Z0-9._/-]*$/.test(token) && (token.includes('.') || token.includes('_') || token.includes('/'))) return true;
  return false;
}

function redactEntropy(text: string): string {
  // Split into tokens on whitespace, process each
  return text.replace(/\S{20,}/g, (token) => {
    if (shannonEntropy(token) >= 4.5 && !isAllowlisted(token)) {
      return '[REDACTED_ENTROPY]';
    }
    return token;
  });
}

// --- Public API ---

/**
 * Applies all three redaction layers sequentially.
 * Layer 1: Pattern-based secrets -> [REDACTED_SECRET]
 * Layer 2: PII patterns -> [REDACTED_PII]
 * Layer 3: Entropy-based -> [REDACTED_ENTROPY]
 * Non-throwing: returns input on error.
 */
export function redactContent(text: string): string {
  try {
    if (!text) return text;
    let result = text;
    result = redactSecrets(result);
    result = redactPII(result);
    result = redactEntropy(result);
    return result;
  } catch {
    return text;
  }
}

/**
 * Sanitizes file paths by replacing user home directory segments.
 * - Windows: C:\Users\{username}\... -> C:\Users\[USER]\...
 * - Unix: /home/{username}/... or /Users/{username}/... -> .../[USER]/...
 * - If projectRoot provided and path starts with it, replaces with <project>/ prefix.
 * Non-throwing: returns input on error.
 */
export function sanitizePath(path: string, projectRoot?: string): string {
  try {
    if (!path) return path;

    // Project-relative replacement first (if provided)
    if (projectRoot && path.startsWith(projectRoot)) {
      const relative = path.slice(projectRoot.length).replace(/^[/\\]/, '');
      return `<project>/${relative}`;
    }

    let result = path;
    // Windows: C:\Users\{username}\...
    result = result.replace(/^(C:\\Users\\)[^\\]+(\\.*)?$/i, '$1[USER]$2');
    // Unix: /home/{username}/... or /Users/{username}/...
    result = result.replace(/^(\/(?:home|Users)\/)[^/]+(\/.*)?$/, '$1[USER]$2');

    return result;
  } catch {
    return path;
  }
}
