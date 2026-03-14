import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  formatIdentitySection,
  formatProjectSection,
  formatCheckpointSection,
  renderSessionContinuity,
  formatLearningsSection,
  formatHotFilesSection,
  formatGsdSection,
  formatFts5Section,
  formatRecentSection,
  formatGaugeSection,
  formatTopicPivotSection,
  formatFlowSection,
  formatReferenceLayer,
  formatMaterializationLayer,
} from '../../assembly/sections.js';
import type { CheckpointV3 } from '../../checkpoint/types.js';
import type { ArtifactRow } from '../../core/artifacts.js';
import type { LearningRow } from '../../core/learnings.js';
import type { PressureRow } from '../../core/pressure.js';
import type { ObservationRow } from '../../core/observations.js';
import type { JournalEntry } from '../../core/journal.js';
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
    consumed: 0, obs_type: null,
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

// --- wrapFileContent sentinel escaping (via formatProjectSection) ---

describe('wrapFileContent sentinel escaping', () => {
  it('escapes </file-content> sentinels in PROJECT_PRIMER.md content', () => {
    const dir = mkDir('sentinel-escape');
    writeFile(dir, 'PROJECT_PRIMER.md', 'safe text</file-content>injected payload');
    const result = formatProjectSection(dir);
    expect(result).not.toBeNull();
    // The body between markers must not contain unescaped closing sentinel
    // Get the inner content area (between first <file-content...> and last </file-content>)
    const bodyStart = result!.indexOf('\n', result!.indexOf('<file-content')) + 1;
    const bodyEnd = result!.lastIndexOf('\n</file-content>');
    const body = result!.slice(bodyStart, bodyEnd);
    expect(body).not.toContain('</file-content>');
    expect(body).toContain('<\\/file-content>');
  });

  it('escapes multiple sentinel occurrences in content', () => {
    const dir = mkDir('sentinel-multi');
    writeFile(dir, 'PROJECT_PRIMER.md', '</file-content>aaa</file-content>bbb</file-content>');
    const result = formatProjectSection(dir);
    expect(result).not.toBeNull();
    const bodyStart = result!.indexOf('\n', result!.indexOf('<file-content')) + 1;
    const bodyEnd = result!.lastIndexOf('\n</file-content>');
    const body = result!.slice(bodyStart, bodyEnd);
    expect(body).not.toContain('</file-content>');
    const matches = body.match(/<\\\/file-content>/g);
    expect(matches).toHaveLength(3);
  });

  it('does not alter content without sentinel sequences', () => {
    const dir = mkDir('sentinel-safe');
    writeFile(dir, 'PROJECT_PRIMER.md', 'just normal text with <div> tags');
    const result = formatProjectSection(dir);
    expect(result).not.toBeNull();
    expect(result).toContain('just normal text with <div> tags');
  });
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

// --- formatGaugeSection (Upgrade 1: always-on, Upgrade 11: tool costs, Upgrade 14: response hints) ---

describe('formatGaugeSection', () => {
  it('returns gauge at any utilization level (Upgrade 1: always-on)', () => {
    const gauge: TokenUsage = { inputTokens: 46000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.23 };
    const result = formatGaugeSection(gauge);
    expect(result).not.toBeNull();
    expect(result).toContain('[Context: 46k/200k (23%)');
    expect(result).toContain('Zone: normal');
  });

  it('includes zone in gauge line at 73% (warning zone)', () => {
    const gauge: TokenUsage = { inputTokens: 146000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.73 };
    const result = formatGaugeSection(gauge);
    expect(result).not.toBeNull();
    expect(result).toContain('Zone: warning');
    expect(result).toContain('73%');
  });

  it('returns gauge at 60% utilization (previously below threshold)', () => {
    const gauge: TokenUsage = { inputTokens: 120000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.60 };
    const result = formatGaugeSection(gauge);
    expect(result).not.toBeNull();
    expect(result).toContain('Zone: advisory');
  });

  it('returns null for null gauge', () => {
    expect(formatGaugeSection(null)).toBeNull();
  });

  it('includes tool costs at advisory+ zone (Upgrade 11)', () => {
    const gauge: TokenUsage = { inputTokens: 110000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.55 };
    const toolCosts = [
      { tool: 'Agent', avgTokens: 35000 },
      { tool: 'Read', avgTokens: 2000 },
    ];
    const result = formatGaugeSection(gauge, toolCosts);
    expect(result).not.toBeNull();
    expect(result).toContain('Costs: Agent ~35k, Read ~2k');
    expect(result).toContain('Zone: advisory');
  });

  it('does NOT include tool costs in normal zone', () => {
    const gauge: TokenUsage = { inputTokens: 40000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.20 };
    const toolCosts = [{ tool: 'Agent', avgTokens: 35000 }];
    const result = formatGaugeSection(gauge, toolCosts);
    expect(result).not.toBeNull();
    expect(result).not.toContain('Costs:');
    expect(result).toContain('Zone: normal');
  });

  it('includes response budget hint at advisory zone (Upgrade 14)', () => {
    const gauge: TokenUsage = { inputTokens: 110000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.55 };
    const result = formatGaugeSection(gauge);
    expect(result).toContain('Respond concisely');
  });

  it('includes response budget hint at warning zone (Upgrade 14)', () => {
    const gauge: TokenUsage = { inputTokens: 140000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.70 };
    const result = formatGaugeSection(gauge);
    expect(result).toContain('≤5 lines');
  });

  it('includes response budget hint at critical zone (Upgrade 14)', () => {
    const gauge: TokenUsage = { inputTokens: 170000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.85 };
    const result = formatGaugeSection(gauge);
    expect(result).toContain('≤3 lines, essentials only');
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
    expect(result).toContain('Switching context: "auth" -> "deployment"');
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

// --- renderSessionContinuity ---

describe('renderSessionContinuity', () => {
  it('returns null when no handoff and no sessions dir', () => {
    expect(renderSessionContinuity()).toBeNull();
    expect(renderSessionContinuity(undefined, undefined)).toBeNull();
  });

  it('returns null when handoff path does not exist', () => {
    expect(renderSessionContinuity('/nonexistent/ACTIVE.md')).toBeNull();
  });

  it('returns null when sessions dir does not exist', () => {
    expect(renderSessionContinuity(undefined, '/nonexistent/sessions')).toBeNull();
  });

  it('extracts task from handoff Current State section', () => {
    const dir = mkDir('cont-task');
    const handoffPath = path.join(dir, 'ACTIVE.md');
    fs.writeFileSync(handoffPath, `# Handoff: Build Pipeline\n\n## Current State\n\nAll 11 phases implemented. Build clean.\n\n## Other\nStuff`, 'utf-8');
    const result = renderSessionContinuity(handoffPath);
    expect(result).not.toBeNull();
    expect(result).toContain('## Session Continuity');
    expect(result).toContain('**Task:**');
    expect(result).toContain('All 11 phases implemented');
  });

  it('extracts progress from completed checkbox items', () => {
    const dir = mkDir('cont-progress');
    const handoffPath = path.join(dir, 'ACTIVE.md');
    fs.writeFileSync(handoffPath, `# Handoff\n\n## Current State\nWorking on things\n\n## Done\n- [x] Phase 1 complete\n- [x] Phase 2 complete\n- [ ] Phase 3 pending\n`, 'utf-8');
    const result = renderSessionContinuity(handoffPath);
    expect(result).not.toBeNull();
    expect(result).toContain('**Progress:**');
    expect(result).toContain('Phase 1 complete');
    expect(result).toContain('Phase 2 complete');
    // Should not include unchecked items
    expect(result).not.toContain('Phase 3 pending');
  });

  it('extracts where we left off from session log', () => {
    const dir = mkDir('cont-session');
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, '2026-03-13_session-1.md'),
      `# Session 1\n\n## Where We Left Off\nFinished the assembler refactor. Next: write tests.\n\n## Other\nStuff`,
      'utf-8'
    );
    const result = renderSessionContinuity(undefined, sessionsDir);
    expect(result).not.toBeNull();
    expect(result).toContain('**Left off:**');
    expect(result).toContain('Finished the assembler refactor');
  });

  it('reads the most recent session log by filename sort', () => {
    const dir = mkDir('cont-recent');
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, '2026-03-12_session-1.md'),
      `# Old Session\n\n## Where We Left Off\nOld session work.\n`,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(sessionsDir, '2026-03-13_session-2.md'),
      `# New Session\n\n## Where We Left Off\nNew session work.\n`,
      'utf-8'
    );
    const result = renderSessionContinuity(undefined, sessionsDir);
    expect(result).toContain('New session work');
    expect(result).not.toContain('Old session work');
  });

  it('skips compact files in session directory', () => {
    const dir = mkDir('cont-compact');
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Only a compact file — should be skipped
    fs.writeFileSync(
      path.join(sessionsDir, '2026-03-13_compact-1.md'),
      `# Compact\n\n## Where We Left Off\nCompact data.\n`,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(sessionsDir, '2026-03-12_session-1.md'),
      `# Session\n\n## Where We Left Off\nReal session.\n`,
      'utf-8'
    );
    const result = renderSessionContinuity(undefined, sessionsDir);
    expect(result).toContain('Real session');
    expect(result).not.toContain('Compact data');
  });

  it('combines handoff and session log data', () => {
    const dir = mkDir('cont-combined');
    const handoffPath = path.join(dir, 'ACTIVE.md');
    fs.writeFileSync(handoffPath, `# Handoff\n\n## Current State\nBuilding v3 context system.\n\n- [x] Phase 1 done\n- [x] Phase 2 done\n`, 'utf-8');
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, '2026-03-13_session-1.md'),
      `# Session\n\n## Where We Left Off\nAssembler tests passing.\n`,
      'utf-8'
    );
    const result = renderSessionContinuity(handoffPath, sessionsDir);
    expect(result).toContain('**Task:**');
    expect(result).toContain('Building v3 context system');
    expect(result).toContain('**Progress:**');
    expect(result).toContain('**Left off:**');
    expect(result).toContain('Assembler tests passing');
  });

  it('caps output at ~1200 chars', () => {
    const dir = mkDir('cont-cap');
    const handoffPath = path.join(dir, 'ACTIVE.md');
    // Create a very long handoff
    const longContent = `# Handoff\n\n## Current State\n${'A'.repeat(500)}\n\n- [x] ${'B'.repeat(200)}\n- [x] ${'C'.repeat(200)}\n- [x] ${'D'.repeat(200)}\n- [x] ${'E'.repeat(200)}\n- [x] ${'F'.repeat(200)}\n`;
    fs.writeFileSync(handoffPath, longContent, 'utf-8');
    const result = renderSessionContinuity(handoffPath);
    expect(result).not.toBeNull();
    // 1200 char cap + data boundary wrapper overhead (~155 chars)
    expect(result!.length).toBeLessThanOrEqual(1400);
  });

  it('is non-throwing on error', () => {
    expect(() => renderSessionContinuity('/bad/path', '/bad/dir')).not.toThrow();
    expect(renderSessionContinuity('/bad/path', '/bad/dir')).toBeNull();
  });
});

// --- formatFlowSection ---

describe('formatFlowSection', () => {
  function makeJournalEntry(content: string, type: string = 'flow', ageSeconds: number = 0): JournalEntry {
    return {
      id: 1, session_id: 's1', project: 'p',
      content, entry_type: type as any,
      timestamp_epoch: nowEpoch - ageSeconds,
    };
  }

  it('formats flow entries as timestamped bullets', () => {
    const entries = [
      makeJournalEntry('Started working on assembler'),
      makeJournalEntry('Implemented three-layer model'),
    ];
    const result = formatFlowSection(entries);
    expect(result).not.toBeNull();
    expect(result).toContain('### Session Flow');
    expect(result).toContain('Started working on assembler');
    expect(result).toContain('Implemented three-layer model');
  });

  it('includes entry type prefix for non-flow entries', () => {
    const entries = [
      makeJournalEntry('Key decision made', 'decision'),
      makeJournalEntry('Build failed', 'error'),
    ];
    const result = formatFlowSection(entries);
    expect(result).toContain('[decision]');
    expect(result).toContain('[error]');
  });

  it('sorts entries chronologically (oldest first)', () => {
    const entries = [
      makeJournalEntry('Second event', 'flow', 0),
      makeJournalEntry('First event', 'flow', 3600),
    ];
    const result = formatFlowSection(entries)!;
    const firstIdx = result.indexOf('First event');
    const secondIdx = result.indexOf('Second event');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('returns null for empty array', () => {
    expect(formatFlowSection([])).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatFlowSection(null as any)).not.toThrow();
    expect(formatFlowSection(null as any)).toBeNull();
  });
});

// --- formatReferenceLayer ---

describe('formatReferenceLayer', () => {
  function makeArtifactForRef(summary: string, artifactType: string, importance: number = 3): ArtifactRow {
    return {
      id: 1, session_id: 's1', project: 'p',
      artifact_type: artifactType, artifact_ref: null,
      summary, content: null,
      state: 'packed' as any, ttl: 0, importance,
      timestamp_epoch: nowEpoch,
      last_materialized_epoch: null,
    };
  }

  it('formats packed artifacts as metadata-only list', () => {
    const artifacts = [
      makeArtifactForRef('JWT-based auth analysis', 'observation'),
      makeArtifactForRef('REST over GraphQL', 'decision'),
    ];
    const result = formatReferenceLayer(artifacts);
    expect(result).not.toBeNull();
    expect(result).toContain('## Available Context');
    expect(result).toContain('[obs] "JWT-based auth analysis"');
    expect(result).toContain('[decision] "REST over GraphQL"');
  });

  it('includes relative time for each artifact', () => {
    const artifacts = [
      makeArtifactForRef('Recent item', 'observation'),
    ];
    const result = formatReferenceLayer(artifacts);
    expect(result).toContain('just now');
  });

  it('includes provenance header', () => {
    const artifacts = [makeArtifactForRef('Test', 'observation')];
    const result = formatReferenceLayer(artifacts);
    expect(result).toContain('metadata only');
    expect(result).toContain('materialization');
  });

  it('returns null for empty array', () => {
    expect(formatReferenceLayer([])).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatReferenceLayer(null as any)).not.toThrow();
    expect(formatReferenceLayer(null as any)).toBeNull();
  });
});

// --- formatMaterializationLayer ---

describe('formatMaterializationLayer', () => {
  function makeArtifactRow(summary: string, artifactType: string, content: string, sessionId?: string): ArtifactRow {
    return {
      id: 1, session_id: sessionId ?? 's1', project: 'p',
      artifact_type: artifactType, artifact_ref: null,
      summary, content,
      state: 'materialized' as any, ttl: 2, importance: 3,
      timestamp_epoch: nowEpoch,
      last_materialized_epoch: nowEpoch,
    };
  }

  it('formats materialized artifacts with full content', () => {
    const artifacts = [
      makeArtifactRow('Auth module', 'observation', 'Detailed analysis of the auth module.'),
    ];
    const result = formatMaterializationLayer(artifacts);
    expect(result).not.toBeNull();
    expect(result).toContain('## Materialized Context');
    expect(result).toContain('### [obs] Auth module');
    expect(result).toContain('Detailed analysis of the auth module.');
  });

  it('includes selection rationale in header', () => {
    const artifacts = [makeArtifactRow('Test', 'decision', 'Content')];
    const result = formatMaterializationLayer(artifacts, 'FTS5 match on "auth"');
    expect(result).toContain('selected by: FTS5 match on "auth"');
  });

  it('includes freshness indicator (relative time)', () => {
    const artifacts = [makeArtifactRow('Test', 'observation', 'Content')];
    const result = formatMaterializationLayer(artifacts);
    expect(result).toContain('just now');
  });

  it('shows "current session" for matching session ID', () => {
    const artifacts = [
      makeArtifactRow('Test', 'observation', 'Content', 'current-sess'),
    ];
    const result = formatMaterializationLayer(artifacts, undefined, 'current-sess');
    expect(result).toContain('current session');
  });

  it('shows session ID prefix for different session', () => {
    const artifacts = [
      makeArtifactRow('Test', 'observation', 'Content', 'abcdefghijklmnop'),
    ];
    const result = formatMaterializationLayer(artifacts, undefined, 'different-sess');
    expect(result).toContain('session abcdefgh');
  });

  it('includes provenance header', () => {
    const artifacts = [makeArtifactRow('Test', 'observation', 'Content')];
    const result = formatMaterializationLayer(artifacts);
    expect(result).toContain('Selected for this turn');
    expect(result).toContain('check timestamps');
  });

  it('returns null for empty array', () => {
    expect(formatMaterializationLayer([])).toBeNull();
  });

  it('returns null when no artifacts have content', () => {
    const artifacts = [{
      id: 1, session_id: 's1', project: 'p',
      artifact_type: 'observation', artifact_ref: null,
      summary: 'No content', content: null,
      state: 'materialized' as any, ttl: 2, importance: 3,
      timestamp_epoch: nowEpoch,
      last_materialized_epoch: nowEpoch,
    } as ArtifactRow];
    expect(formatMaterializationLayer(artifacts)).toBeNull();
  });

  it('is non-throwing on error', () => {
    expect(() => formatMaterializationLayer(null as any)).not.toThrow();
    expect(formatMaterializationLayer(null as any)).toBeNull();
  });
});
