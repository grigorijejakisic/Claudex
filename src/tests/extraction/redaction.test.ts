import { redactContent, sanitizePath, shannonEntropy } from '../../extraction/redaction.js';

describe('redaction engine', () => {
  // --- Layer 1: Pattern-based secrets ---

  describe('Layer 1 — secrets', () => {
    it('redacts AWS access key (AKIA pattern)', () => {
      const input = 'aws key: AKIAIOSFODNN7EXAMPLE';
      expect(redactContent(input)).toBe('aws key: [REDACTED_SECRET]');
    });

    it('redacts GitHub PAT (ghp_ pattern)', () => {
      const input = 'token: ghp_ABCDEFghijklmnopqrstuvwxyz0123456789';
      expect(redactContent(input)).toBe('token: [REDACTED_SECRET]');
    });

    it('redacts JWT tokens', () => {
      const input = 'jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
      const result = redactContent(input);
      expect(result).toContain('[REDACTED_SECRET]');
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('redacts Bearer tokens', () => {
      const input = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234';
      expect(redactContent(input)).toBe('Authorization: [REDACTED_SECRET]');
    });

    it('redacts generic API keys (sk- pattern)', () => {
      const input = 'key: sk-abcdefghijklmnopqrstuvwxyz';
      expect(redactContent(input)).toBe('key: [REDACTED_SECRET]');
    });

    it('redacts base64 strings > 32 chars', () => {
      const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij==';
      const input = `encoded: ${b64}`;
      expect(redactContent(input)).toBe('encoded: [REDACTED_SECRET]');
    });

    it('preserves normal code content', () => {
      const input = 'const x = 42; function hello() { return "world"; }';
      expect(redactContent(input)).toBe(input);
    });
  });

  // --- Layer 2: PII patterns ---

  describe('Layer 2 — PII', () => {
    it('redacts email addresses', () => {
      const input = 'contact: user@example.com';
      expect(redactContent(input)).toBe('contact: [REDACTED_PII]');
    });

    it('redacts phone numbers (US format)', () => {
      const input = 'call: (555) 123-4567';
      expect(redactContent(input)).toBe('call: [REDACTED_PII]');
    });

    it('redacts SSN patterns', () => {
      const input = 'ssn: 123-45-6789';
      expect(redactContent(input)).toBe('ssn: [REDACTED_PII]');
    });

    it('redacts credit card numbers', () => {
      const input = 'card: 4111 1111 1111 1111';
      expect(redactContent(input)).toBe('card: [REDACTED_PII]');
    });

    it('redacts public IP addresses', () => {
      const input = 'server: 203.0.113.42';
      expect(redactContent(input)).toBe('server: [REDACTED_PII]');
    });

    it('preserves private IP addresses (10.x, 192.168.x)', () => {
      const input1 = 'local: 10.0.0.1';
      const input2 = 'local: 192.168.1.1';
      const input3 = 'local: 127.0.0.1';
      expect(redactContent(input1)).toBe(input1);
      expect(redactContent(input2)).toBe(input2);
      expect(redactContent(input3)).toBe(input3);
    });
  });

  // --- Layer 3: Entropy-based ---

  describe('Layer 3 — entropy', () => {
    it('redacts high-entropy strings (>= 4.5 entropy, >= 20 chars)', () => {
      // High-entropy random-looking string, 24 chars
      const highEntropy = 'aZ9$xQ!mK3&rW7^pL2@nY5#';
      expect(shannonEntropy(highEntropy)).toBeGreaterThanOrEqual(4.5);
      const result = redactContent(`data: ${highEntropy}`);
      expect(result).toBe('data: [REDACTED_ENTROPY]');
    });

    it('preserves file paths despite high entropy', () => {
      const input = 'file: /usr/local/lib/node_modules/some-pkg/dist/index.js';
      expect(redactContent(input)).toBe(input);
    });

    it('preserves URLs despite high entropy', () => {
      const input = 'url: https://api.example.com/v2/users?q=search&limit=50';
      expect(redactContent(input)).toBe(input);
    });

    it('preserves UUIDs despite high entropy', () => {
      const input = 'id: 550e8400-e29b-41d4-a716-446655440000';
      expect(redactContent(input)).toBe(input);
    });

    it('preserves hex hashes despite high entropy', () => {
      const input = 'hash: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
      expect(redactContent(input)).toBe(input);
    });

    it('preserves node_modules paths', () => {
      const input = 'path: node_modules/@types/better-sqlite3/index.d.ts';
      expect(redactContent(input)).toBe(input);
    });
  });

  // --- Path sanitization ---

  describe('sanitizePath', () => {
    it('replaces Windows username', () => {
      const result = sanitizePath('C:\\Users\\JohnDoe\\Documents\\file.txt');
      expect(result).toBe('C:\\Users\\[USER]\\Documents\\file.txt');
    });

    it('replaces Unix username', () => {
      const result1 = sanitizePath('/home/johndoe/projects/app.ts');
      expect(result1).toBe('/home/[USER]/projects/app.ts');

      const result2 = sanitizePath('/Users/johndoe/projects/app.ts');
      expect(result2).toBe('/Users/[USER]/projects/app.ts');
    });

    it('applies project-relative prefix when projectRoot given', () => {
      const result = sanitizePath(
        '/home/johndoe/projects/myapp/src/index.ts',
        '/home/johndoe/projects/myapp'
      );
      expect(result).toBe('<project>/src/index.ts');
    });

    it('returns input on non-matching paths', () => {
      const input = 'relative/path/to/file.ts';
      expect(sanitizePath(input)).toBe(input);
    });
  });

  // --- Combined ---

  describe('combined', () => {
    it('redactContent applies all three layers in sequence', () => {
      const input = 'key: sk-abcdefghijklmnopqrstuvwxyz, email: test@example.com, data: aZ9$xQ!mK3&rW7^pL2@nY5#';
      const result = redactContent(input);
      expect(result).toContain('[REDACTED_SECRET]');
      expect(result).toContain('[REDACTED_PII]');
      expect(result).toContain('[REDACTED_ENTROPY]');
      expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
      expect(result).not.toContain('test@example.com');
    });

    it('redactContent is non-throwing (returns input on error)', () => {
      // Test with null/undefined coerced - the function should not throw
      const result = redactContent('' as string);
      expect(typeof result).toBe('string');
    });
  });
});
