import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  formatIdentitySection,
  formatProjectSection,
  formatCheckpointSection,
  formatLearningsSection,
  formatHotFilesSection,
  formatGsdSection,
  formatFts5Section,
  formatRecentSection,
  formatGaugeSection,
  formatTopicPivotSection,
} from '../../assembly/sections.js';
import type { CheckpointV3 } from '../../checkpoint/types.js';
import type { LearningRow } from '../../core/learnings.js';
import type { PressureRow } from '../../core/pressure.js';
import type { ObservationRow } from '../../core/observations.js';
import type { GsdState } from '../../gsd/types.js';
import type { TokenUsage } from '../../shared/types.js';
import type { TopicShiftResult } from '../../intelligence/topic-shift.js';

let tmpDir: string;

function mkDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(base: string, rel: string, content: string): void {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

const nowEpoch = Math.floor(Date.now() / 1000);

function makeLearning(content: string, count: number): LearningRow {
  return {
    id: 1, project: 'p', agent_id: 'default', fingerprint: 'fp',
    content, promotion_count: count,
    first_seen_epoch: nowEpoch, last_promoted_epoch: nowEpoch, updated_at_epoch: nowEpoch,
  };
}

function makePressure(filePath: string, pressure: number): PressureRow {
  return {
    file_path: filePath, project: 'p', raw_pressure: pressure,
    temperature: pressure >= 0.5 ? 'HOT' : 'COLD',
    last_touched_epoch: nowEpoch, decay_rate: 0.1,
  };
}

function makeObservation(title: string, category: string, content: string, ageSeconds: number = 0): ObservationRow {
  return {
    id: 1, session_id: 's1', project: 'p', tool_name: 'Read',
    category, title, content, importance: 4,
    files_modified: '[]', timestamp_epoch: nowEpoch - ageSeconds,
    access_count: 0, last_accessed_at_epoch: null, deleted_at_epoch: null,
  };
}

function makeCheckpoint(overrides?: Partial<CheckpointV3>): CheckpointV3 {
  return {
    schema: 'claudex/checkpoint',
    version: 3,
    meta: {
      checkpoint_id: 'cp1', session_id: 's1', scope: 'project:test',
      trigger: 'threshold', token_usage: null, previous_checkpoint: null,
    },
    working: { task: 'Build assembler', status: 'in_progress', next_action: 'Write tests', branch: 'main' },
    decisions: [{ content: 'Use priority cascade', source: 'regex', timestamp: nowEpoch }],
    files: { hot: [{ path: 'src/a.ts', last_action: 'edited' }], read: ['src/b.ts'] },
    thread: { topic: 'assembly pipeline', summary: 'Building context injection', key_exchanges: [] },
    open_items: ['Write more tests'],
    learnings: ['Always budget first'],
    gsd: null,
    ...overrides,
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-sections-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- formatIdentitySection ---

describe('formatIdentitySection', () => {
  it('returns identity content when USER.md exists', () => {
    const dir = mkDir('id-exists');
    writeFile(dir, 'USER.md', 'I am a developer');
    const result = formatIdentitySection(dir);
    expect(result).not.toBeNull();
    expect(result).toContain('## Identity');
    expect(result).toContain('I am a developer');
  });

  it('returns null when USER.md does not exist', () => {
    const dir = mkDir('id-missing');
    expect(formatIdentitySection(dir)).toBeNull();
  });

  it('returns null when USER.md is empty', () => {
    const dir = mkDir('id-empty');
    writeFile(dir, 'USER.md', '');
    expect(formatIdentitySection(dir)).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatIdentitySection('/nonexistent/path/xyz')).not.toThrow();
    expect(formatIdentitySection('/nonexistent/path/xyz')).toBeNull();
  });
});

// --- formatProjectSection ---

describe('formatProjectSection', () => {
  it('returns project section with primer', () => {
    const dir = mkDir('proj-primer');
    writeFile(dir, 'PROJECT_PRIMER.md', 'This is a project');
    const result = formatProjectSection(dir);
    expect(result).not.toBeNull();
    expect(result).toContain('## Project');
    expect(result).toContain('This is a project');
  });

  it('returns project section with primer and active handoff', () => {
    const dir = mkDir('proj-both');
    writeFile(dir, 'PROJECT_PRIMER.md', 'Primer content');
    writeFile(dir, 'context/handoffs/ACTIVE.md', 'Active handoff content');
    const result = formatProjectSection(dir);
    expect(result).toContain('## Project');
    expect(result).toContain('Primer content');
    expect(result).toContain('## Active Handoff');
    expect(result).toContain('Active handoff content');
  });

  it('returns project section with only active handoff', () => {
    const dir = mkDir('proj-active-only');
    writeFile(dir, 'context/handoffs/ACTIVE.md', 'Active only');
    const result = formatProjectSection(dir);
    expect(result).not.toBeNull();
    expect(result).toContain('## Active Handoff');
    expect(result).toContain('Active only');
  });

  it('returns null when neither file exists', () => {
    const dir = mkDir('proj-empty');
    expect(formatProjectSection(dir)).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatProjectSection('/nonexistent/path/xyz')).not.toThrow();
    expect(formatProjectSection('/nonexistent/path/xyz')).toBeNull();
  });
});

// --- formatCheckpointSection ---

describe('formatCheckpointSection', () => {
  it('renders checkpoint markdown with RESUME preset', () => {
    const cp = makeCheckpoint();
    const result = formatCheckpointSection(cp);
    expect(result).not.toBeNull();
    expect(result).toContain('## Checkpoint');
    expect(result).toContain('Build assembler');
    expect(result).toContain('Use priority cascade');
  });

  it('returns null for null checkpoint', () => {
    expect(formatCheckpointSection(null)).toBeNull();
  });

  it('returns null for checkpoint with no meaningful content', () => {
    const cp = makeCheckpoint({
      working: { task: null, status: null, next_action: null, branch: null },
      decisions: [],
      files: { hot: [], read: [] },
      thread: { topic: null, summary: null, key_exchanges: [] },
      open_items: [],
      learnings: [],
    });
    expect(formatCheckpointSection(cp)).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatCheckpointSection({} as any)).not.toThrow();
  });
});

// --- formatLearningsSection ---

describe('formatLearningsSection', () => {
  it('formats learnings as bullet list with promotion count', () => {
    const learnings = [
      makeLearning('Always test first', 5),
      makeLearning('Use strict types', 3),
      makeLearning('Keep functions small', 1),
    ];
    const result = formatLearningsSection(learnings);
    expect(result).not.toBeNull();
    expect(result).toContain('## Learnings');
    expect(result).toContain('- Always test first (x5)');
    expect(result).toContain('- Use strict types (x3)');
    expect(result).toContain('- Keep functions small (x1)');
  });

  it('returns null for empty array', () => {
    expect(formatLearningsSection([])).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatLearningsSection(null as any)).not.toThrow();
    expect(formatLearningsSection(null as any)).toBeNull();
  });
});

// --- formatHotFilesSection ---

describe('formatHotFilesSection', () => {
  it('formats hot files above 0.851 threshold', () => {
    const files = [
      makePressure('src/a.ts', 0.95),
      makePressure('src/b.ts', 0.86),
      makePressure('src/c.ts', 0.50), // below 0.851 — excluded
    ];
    const result = formatHotFilesSection(files);
    expect(result).not.toBeNull();
    expect(result).toContain('## Hot Files');
    expect(result).toContain('src/a.ts');
    expect(result).toContain('src/b.ts');
    expect(result).not.toContain('src/c.ts');
  });

  it('returns null when no files above threshold', () => {
    const files = [makePressure('src/x.ts', 0.50)];
    expect(formatHotFilesSection(files)).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(formatHotFilesSection([])).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatHotFilesSection(null as any)).not.toThrow();
    expect(formatHotFilesSection(null as any)).toBeNull();
  });
});

// --- formatGsdSection ---

describe('formatGsdSection', () => {
  it('formats GSD state with phase, goal, status, completion', () => {
    const gsd: GsdState = {
      phase: 5, plan: 1, status: 'In progress',
      goal: 'Assembly pipeline', success_criteria: [], completion: '3/5 requirements met',
    };
    const result = formatGsdSection(gsd);
    expect(result).not.toBeNull();
    expect(result).toContain('## GSD State');
    expect(result).toContain('**Phase 5:**');
    expect(result).toContain('Assembly pipeline');
    expect(result).toContain('**Status:** In progress');
    expect(result).toContain('**Completion:** 3/5 requirements met');
  });

  it('includes success criteria when present', () => {
    const gsd: GsdState = {
      phase: 5, plan: 1, status: 'active',
      goal: 'Assembly', success_criteria: ['Token budget works', 'Three-tier degradation'],
      completion: '1/2',
    };
    const result = formatGsdSection(gsd);
    expect(result).toContain('**Success Criteria:**');
    expect(result).toContain('- Token budget works');
    expect(result).toContain('- Three-tier degradation');
  });

  it('returns null for null GSD', () => {
    expect(formatGsdSection(null)).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatGsdSection({} as any)).not.toThrow();
  });
});

// --- formatFts5Section ---

describe('formatFts5Section', () => {
  it('formats observations in full mode (default)', () => {
    const obs = [makeObservation('Auth refactor', 'code', 'Refactored OAuth module')];
    const result = formatFts5Section(obs);
    expect(result).not.toBeNull();
    expect(result).toContain('## Relevant Observations');
    expect(result).toContain('### Auth refactor');
    expect(result).toContain('*code |');
    expect(result).toContain('Refactored OAuth module');
  });

  it('formats observations in reference mode', () => {
    const obs = [makeObservation('Auth refactor', 'code', 'Refactored OAuth module')];
    const result = formatFts5Section(obs, true);
    expect(result).not.toBeNull();
    expect(result).toContain('## Relevant Observations');
    expect(result).toContain('- [code] Auth refactor');
    expect(result).not.toContain('### Auth refactor');
    expect(result).not.toContain('Refactored OAuth module');
  });

  it('returns null for empty array', () => {
    expect(formatFts5Section([])).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatFts5Section(null as any)).not.toThrow();
    expect(formatFts5Section(null as any)).toBeNull();
  });
});

// --- formatRecentSection ---

describe('formatRecentSection', () => {
  it('formats recent observations as compact references', () => {
    const obs = [
      makeObservation('Build fix', 'error', 'Fixed build error'),
      makeObservation('DB migration', 'architecture', 'Added new table'),
      makeObservation('Config change', 'config', 'Updated threshold'),
    ];
    const result = formatRecentSection(obs);
    expect(result).not.toBeNull();
    expect(result).toContain('## Recent Observations');
    expect(result).toContain('- [error] Build fix');
    expect(result).toContain('- [architecture] DB migration');
    expect(result).toContain('- [config] Config change');
  });

  it('returns null for empty array', () => {
    expect(formatRecentSection([])).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatRecentSection(null as any)).not.toThrow();
    expect(formatRecentSection(null as any)).toBeNull();
  });
});

// --- formatGaugeSection ---

describe('formatGaugeSection', () => {
  it('returns gauge markdown at 70% utilization', () => {
    const gauge: TokenUsage = { inputTokens: 146000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.73 };
    const result = formatGaugeSection(gauge);
    expect(result).not.toBeNull();
    expect(result).toContain('# Token Gauge');
    expect(result).toContain('Utilization: 73%');
    expect(result).toContain('146,000');
    expect(result).toContain('200,000');
  });

  it('returns null below threshold', () => {
    const gauge: TokenUsage = { inputTokens: 120000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.60 };
    expect(formatGaugeSection(gauge)).toBeNull();
  });

  it('returns null for null gauge', () => {
    expect(formatGaugeSection(null)).toBeNull();
  });

  it('uses custom threshold when provided', () => {
    const gauge: TokenUsage = { inputTokens: 110000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.55 };
    const result = formatGaugeSection(gauge, 0.50);
    expect(result).not.toBeNull();
    expect(result).toContain('Utilization: 55%');
  });

  it('is non-throwing on error', () => {
    expect(() => formatGaugeSection({} as any)).not.toThrow();
  });
});

// --- formatTopicPivotSection ---

describe('formatTopicPivotSection', () => {
  it('formats pivot with transition marker', () => {
    const shift: TopicShiftResult = { shifted: true, previousTopic: 'auth', newTopic: 'deployment', confidence: 0.8, method: 'embedding' };
    const result = formatTopicPivotSection({ shift });
    expect(result).not.toBeNull();
    expect(result).toContain('## Context Pivot');
    expect(result).toContain('Switching context: auth -> deployment');
  });

  it('includes relevant learnings when provided', () => {
    const shift: TopicShiftResult = { shifted: true, previousTopic: 'a', newTopic: 'b' };
    const learnings = [makeLearning('Always test first', 3), makeLearning('Check types', 2)];
    const result = formatTopicPivotSection({ shift, learnings });
    expect(result).toContain('**Relevant Learnings:**');
    expect(result).toContain('- Always test first');
    expect(result).toContain('- Check types');
  });

  it('includes hot files and decisions when provided', () => {
    const shift: TopicShiftResult = { shifted: true, previousTopic: 'a', newTopic: 'b' };
    const hotFiles = [makePressure('src/deploy.ts', 0.9)];
    const decisions = [{ content: 'Use Docker', source: 'regex' }];
    const result = formatTopicPivotSection({ shift, hotFiles, decisions });
    expect(result).toContain('**Related Files:**');
    expect(result).toContain('- src/deploy.ts');
    expect(result).toContain('**Related Decisions:**');
    expect(result).toContain('- Use Docker');
  });

  it('returns null when shift.shifted is false', () => {
    const shift: TopicShiftResult = { shifted: false };
    expect(formatTopicPivotSection({ shift })).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatTopicPivotSection({} as any)).not.toThrow();
    expect(() => formatTopicPivotSection({ shift: null } as any)).not.toThrow();
  });
});
