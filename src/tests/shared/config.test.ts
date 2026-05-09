import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../shared/paths.js', () => ({
  getConfigPath: vi.fn(() => '/mock/config.json'),
}));

vi.mock('../../shared/fs-helpers.js', () => ({
  readJsonFile: vi.fn(() => null),
}));

import { loadConfig, getDefaultConfig } from '../../shared/config.js';
import { readJsonFile } from '../../shared/fs-helpers.js';

const mockReadJsonFile = vi.mocked(readJsonFile);

describe('loadConfig', () => {
  beforeEach(() => {
    mockReadJsonFile.mockReset();
  });

  it('returns defaults when config file is missing', () => {
    mockReadJsonFile.mockReturnValue(null);
    const config = loadConfig();
    expect(config).toEqual(getDefaultConfig());
  });

  it('merges valid overrides into defaults', () => {
    mockReadJsonFile.mockReturnValue({
      injection: { budget_tokens: 8000 },
    });
    const config = loadConfig();
    expect(config.injection.budget_tokens).toBe(8000);
    // Other sections untouched
    expect(config.embeddings.enabled).toBe(true);
  });

  it('falls back to default when boolean field has wrong type (string)', () => {
    mockReadJsonFile.mockReturnValue({
      embeddings: { enabled: 'yes' }, // string instead of boolean
    });
    const config = loadConfig();
    expect(config.embeddings.enabled).toBe(true); // default
  });

  it('falls back to default when number field has wrong type (string)', () => {
    mockReadJsonFile.mockReturnValue({
      injection: { budget_tokens: 'lots' }, // string instead of number
    });
    const config = loadConfig();
    expect(config.injection.budget_tokens).toBe(8000); // default
  });

  it('falls back to default when string field has wrong type (number)', () => {
    mockReadJsonFile.mockReturnValue({
      enrichment: { provider: 42 }, // number instead of string
    });
    const config = loadConfig();
    expect(config.enrichment.provider).toBe('auto'); // default
  });

  it('replaces entire section when section is a primitive instead of object', () => {
    mockReadJsonFile.mockReturnValue({
      embeddings: 'broken', // string instead of object
    });
    const config = loadConfig();
    expect(config.embeddings).toEqual(getDefaultConfig().embeddings);
  });

  it('replaces entire section when section is an array instead of object', () => {
    mockReadJsonFile.mockReturnValue({
      observability: [1, 2, 3], // array instead of object
    });
    const config = loadConfig();
    expect(config.observability).toEqual(getDefaultConfig().observability);
  });

  it('replaces entire section when section is null', () => {
    mockReadJsonFile.mockReturnValue({
      context: null,
    });
    const config = loadConfig();
    expect(config.context).toEqual(getDefaultConfig().context);
  });

  it('preserves valid override while fixing invalid sibling field', () => {
    mockReadJsonFile.mockReturnValue({
      embeddings: {
        enabled: false,    // valid boolean override
        provider: 123,     // invalid: number instead of string
      },
    });
    const config = loadConfig();
    expect(config.embeddings.enabled).toBe(false);            // valid override kept
    expect(config.embeddings.provider).toBe('ollama');         // invalid field reset to default
  });

  it('handles unknown keys without crashing — strips them (R28)', () => {
    mockReadJsonFile.mockReturnValue({
      unknown_section: { foo: 'bar' },
      injection: { budget_tokens: 5000, unknown_field: true },
    });
    const config = loadConfig();
    // Valid override applied
    expect(config.injection.budget_tokens).toBe(5000);
    // R28: Unknown top-level key is stripped (not merged into config)
    expect((config as unknown as Record<string, unknown>)['unknown_section']).toBeUndefined();
    // R28: Unknown field in known section is stripped
    expect((config.injection as Record<string, unknown>)['unknown_field']).toBeUndefined();
  });

  it('validates top-level fields: schema, version', () => {
    mockReadJsonFile.mockReturnValue({
      schema: 123,        // number instead of string
      version: 'three',   // string instead of number
    });
    const config = loadConfig();
    const defaults = getDefaultConfig();
    expect(config.schema).toBe(defaults.schema);
    expect(config.version).toBe(defaults.version);
  });

  it('loads config with unicode values without corruption', () => {
    mockReadJsonFile.mockReturnValue({
      enrichment: { ollama_model: 'ünîcödé-model' },
    });
    const config = loadConfig();
    expect(config.enrichment.ollama_model).toBe('ünîcödé-model');
    // Other defaults preserved
    expect(config.enrichment.enabled).toBe(true);
    expect(config.enrichment.provider).toBe('auto');
  });

  it('includes jaccard_shift_threshold in embeddings defaults', () => {
    mockReadJsonFile.mockReturnValue(null);
    const config = loadConfig();
    expect(config.embeddings.jaccard_shift_threshold).toBe(0.15);
  });

  it('validates jaccard_shift_threshold falls back to default on wrong type', () => {
    mockReadJsonFile.mockReturnValue({
      embeddings: { jaccard_shift_threshold: 'high' }, // string instead of number
    });
    const config = loadConfig();
    expect(config.embeddings.jaccard_shift_threshold).toBe(0.15);
  });

  it('handles config with unicode string values in all sections', () => {
    mockReadJsonFile.mockReturnValue({
      embeddings: { provider: '提供者' },
    });
    const config = loadConfig();
    expect(config.embeddings.provider).toBe('提供者');
  });

  // v6.routing — Phase 10 CONTEXT decision 3 (five locked first-principles defaults)
  it('exposes v6.routing block with five locked defaults', () => {
    mockReadJsonFile.mockReturnValue(null);
    const config = loadConfig();
    expect(config.v6.routing.top_k_per_artifact).toBe(3);
    expect(config.v6.routing.max_k_per_query).toBe(12);
    expect(config.v6.routing.token_pct_cap).toBe(15);
    expect(config.v6.routing.bi_encoder_budget_pct).toBe(50);
    expect(config.v6.routing.reranker_mode).toBe('bi_encoder_primary');
  });

  it('coerces v6.routing fields with wrong types back to defaults', () => {
    mockReadJsonFile.mockReturnValue({
      v6: { routing: { top_k_per_artifact: 'three', reranker_mode: 'bogus_mode' } },
    });
    const config = loadConfig();
    expect(config.v6.routing.top_k_per_artifact).toBe(3);
    expect(config.v6.routing.reranker_mode).toBe('bi_encoder_primary');
  });

  it('accepts cross_encoder_primary as a valid reranker_mode', () => {
    mockReadJsonFile.mockReturnValue({
      v6: { routing: { reranker_mode: 'cross_encoder_primary' } },
    });
    const config = loadConfig();
    expect(config.v6.routing.reranker_mode).toBe('cross_encoder_primary');
  });

  it('replaces v6.routing entirely when block is a primitive', () => {
    mockReadJsonFile.mockReturnValue({ v6: { routing: 'broken' } });
    const config = loadConfig();
    expect(config.v6.routing).toEqual(getDefaultConfig().v6.routing);
  });
});
