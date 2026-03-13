/**
 * Ollama nomic-embed-text client with health check and graceful fallback.
 * Non-throwing class — all public methods return null/false on error.
 * @see Architecture Section 6.1 — Stage 2 embedding classification
 */

import { fetchJsonWithTimeout } from '../shared/fetch-utils.js';
import { isPrivateIPv4 } from '../shared/network-safety.js';

/**
 * Validates that a URL points to localhost, loopback, or a private network address.
 * Rejects any URL that could route sensitive data to an external endpoint.
 * Returns true if the URL is safe (local/private), false otherwise.
 */
export function isLocalOrPrivateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;

    // Localhost / loopback
    if (hostname === 'localhost') return true;
    if (hostname === '127.0.0.1') return true;
    if (hostname === '::1') return true;
    if (hostname === '0.0.0.0') return true;
    // Bracket-wrapped IPv6 loopback
    if (hostname === '[::1]') return true;

    // Private IPv4 ranges (shared helper)
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (isPrivateIPv4(a, b)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Wraps Ollama embedding API. Lazily checks availability,
 * caches health status, returns null when unavailable.
 */
export class EmbeddingProvider {
  private baseUrl: string;
  private model: string;
  private available: boolean | null; // null = not yet checked
  private urlBlocked: boolean; // immutable after construction

  constructor(config?: { baseUrl?: string; model?: string }) {
    this.baseUrl = config?.baseUrl ?? 'http://localhost:11434';
    this.model = config?.model ?? 'nomic-embed-text';
    this.available = null;
    this.urlBlocked = false;

    // Validate baseUrl — reject external endpoints
    if (!isLocalOrPrivateUrl(this.baseUrl)) {
      console.warn(`[claudex] EmbeddingProvider: baseUrl "${this.baseUrl}" is not a local/private address. Network calls will be skipped.`);
      this.available = false;
      this.urlBlocked = true;
    }
  }

  /**
   * Health check: verifies Ollama is running and has the target model.
   * Caches result (avoids re-checking every call).
   * Returns false on any error. Non-throwing.
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (this.available !== null) return this.available;

      const data = await fetchJsonWithTimeout(`${this.baseUrl}/api/tags`, {
        timeoutMs: 3000,
      }) as { models?: Array<{ name: string }> } | null;

      if (!data) {
        this.available = false;
        return false;
      }

      const models: Array<{ name: string }> = data.models ?? [];
      this.available = models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`)
      );

      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  /**
   * Compute embedding for text via Ollama /api/embed.
   * Returns null when unavailable or on any error. Non-throwing.
   */
  async embed(text: string): Promise<number[] | null> {
    try {
      if (this.available === false) return null;
      if (this.available === null) {
        const ok = await this.isAvailable();
        if (!ok) return null;
      }

      const data = await fetchJsonWithTimeout(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: text }),
        timeoutMs: 5000,
      }) as { embeddings?: number[][] } | null;

      if (!data) return null;

      const embeddings: number[][] = data.embeddings as number[][];
      if (!Array.isArray(embeddings) || embeddings.length === 0) return null;
      return embeddings[0];
    } catch {
      return null;
    }
  }

  /**
   * Compute embeddings for multiple texts in a single Ollama /api/embed call.
   * Ollama supports `input: string[]` returning `embeddings: number[][]`.
   * Returns array of same length as input — null for any position that fails.
   * Returns all-null array when unavailable or on error. Non-throwing.
   */
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    try {
      if (texts.length === 0) return [];
      // Single item: delegate to embed() for simplicity
      if (texts.length === 1) {
        const result = await this.embed(texts[0]);
        return [result];
      }

      if (this.available === false) return texts.map(() => null);
      if (this.available === null) {
        const ok = await this.isAvailable();
        if (!ok) return texts.map(() => null);
      }

      // Longer timeout for batch: 5s base + 1s per additional text, capped at 30s
      const timeoutMs = Math.min(5000 + (texts.length - 1) * 1000, 30000);

      const data = await fetchJsonWithTimeout(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        timeoutMs,
      }) as { embeddings?: number[][] } | null;

      if (!data) return texts.map(() => null);

      const embeddings: number[][] = data.embeddings as number[][];
      if (!Array.isArray(embeddings)) return texts.map(() => null);

      // Map results: return null for missing positions
      return texts.map((_, i) => {
        const emb = embeddings[i];
        return Array.isArray(emb) && emb.length > 0 ? emb : null;
      });
    } catch {
      return texts.map(() => null);
    }
  }

  /**
   * Clear cached availability for re-check (testing or reconnect).
   * Does not reset URL-blocked providers — external URLs remain blocked.
   */
  resetAvailability(): void {
    if (!this.urlBlocked) {
      this.available = null;
    }
  }
}
