import {
  TOOL_CATALOG,
  KNOWN_TOOL_NAMES,
  FILE_TOOL_NAMES,
  getToolDefinition,
  isKnownTool,
  type ToolDefinition,
} from '../../shared/tool-catalog.js';

/** The 10 tools defined in Architecture Section 5.2. */
const EXPECTED_TOOLS = [
  'Read', 'Edit', 'Write', 'Bash', 'Grep',
  'Glob', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
];

describe('TOOL_CATALOG', () => {
  it('contains all 10 known tools', () => {
    for (const name of EXPECTED_TOOLS) {
      expect(TOOL_CATALOG[name]).toBeDefined();
    }
  });

  it('contains exactly 10 entries (no extras)', () => {
    expect(Object.keys(TOOL_CATALOG)).toHaveLength(10);
  });

  it('has no duplicate names', () => {
    const names = Object.values(TOOL_CATALOG).map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every entry name matches its key', () => {
    for (const [key, def] of Object.entries(TOOL_CATALOG)) {
      expect(def.name).toBe(key);
    }
  });

  it('every entry has at least one keyField', () => {
    for (const def of Object.values(TOOL_CATALOG)) {
      expect(def.keyFields.length).toBeGreaterThan(0);
    }
  });

  it('every entry has at least one behaviorHint', () => {
    for (const def of Object.values(TOOL_CATALOG)) {
      expect(def.behaviorHints.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a valid defaultCategory', () => {
    const validCategories = [
      'code', 'architecture', 'decision', 'error', 'test',
      'config', 'dependency', 'documentation', 'performance',
      'security', 'other',
    ];
    for (const def of Object.values(TOOL_CATALOG)) {
      expect(validCategories).toContain(def.defaultCategory);
    }
  });
});

describe('KNOWN_TOOL_NAMES', () => {
  it('is an array of all 10 tool names', () => {
    expect(KNOWN_TOOL_NAMES).toHaveLength(10);
    for (const name of EXPECTED_TOOLS) {
      expect(KNOWN_TOOL_NAMES).toContain(name);
    }
  });
});

describe('FILE_TOOL_NAMES', () => {
  it('contains file-related tools (defaultCategory = code)', () => {
    for (const name of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit']) {
      expect(FILE_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it('does not contain non-file tools', () => {
    for (const name of ['Bash', 'WebFetch', 'WebSearch', 'Task']) {
      expect(FILE_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});

describe('getToolDefinition', () => {
  it('returns definition for known tool', () => {
    const def = getToolDefinition('Read');
    expect(def).toBeDefined();
    expect(def!.name).toBe('Read');
    expect(def!.keyFields).toContain('file_path');
  });

  it('returns undefined for unknown tool', () => {
    expect(getToolDefinition('UnknownTool')).toBeUndefined();
  });
});

describe('isKnownTool', () => {
  it('returns true for known tools', () => {
    for (const name of EXPECTED_TOOLS) {
      expect(isKnownTool(name)).toBe(true);
    }
  });

  it('returns false for unknown tools', () => {
    expect(isKnownTool('FooBar')).toBe(false);
    expect(isKnownTool('')).toBe(false);
  });
});
