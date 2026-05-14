import { describe, it, expect } from 'vitest';
import {
  classifyQuestion,
  checkOpenBlockers,
  shouldWriteArtifact,
  type QuestionRecord,
} from '../../../skills/auto/block-gate.js';

function q(
  id: string,
  summary: string,
  classification: 'BLOCK' | 'FLAG',
  status: 'open' | 'answered',
): QuestionRecord {
  return { id, summary, classification, status };
}

describe('classifyQuestion — fixed-category floor', () => {
  it('promotes scope question to BLOCK regardless of skill classification', () => {
    expect(classifyQuestion('What is in scope for this phase?', [], 'FLAG')).toBe('BLOCK');
  });

  it('promotes methodology question to BLOCK', () => {
    expect(classifyQuestion('Which methodology should we use for measurement?', [], 'FLAG')).toBe('BLOCK');
  });

  it('promotes prerequisite question to BLOCK', () => {
    expect(classifyQuestion('What prerequisites must complete first?', [], 'FLAG')).toBe('BLOCK');
  });

  it('promotes wave structure question to BLOCK', () => {
    expect(classifyQuestion('How should the wave structure be organized?', [], 'FLAG')).toBe('BLOCK');
  });

  it('promotes to BLOCK when touches active conversation topic', () => {
    const activeTopics = ['retrieval ranking', 'big-balkan'];
    expect(
      classifyQuestion('How should retrieval ranking be rebalanced?', activeTopics, 'FLAG'),
    ).toBe('BLOCK');
  });

  it('keeps FLAG for innocuous style question with no active-topic overlap', () => {
    expect(
      classifyQuestion('Should we use camelCase or snake_case for this variable?', [], 'FLAG'),
    ).toBe('FLAG');
  });

  it('respects skill BLOCK classification when question does not match auto-floor', () => {
    expect(classifyQuestion('Output format preference?', [], 'BLOCK')).toBe('BLOCK');
  });
});

describe('checkOpenBlockers', () => {
  it('returns open BLOCK questions only', () => {
    const log: QuestionRecord[] = [
      q('Q1', 'scope decision', 'BLOCK', 'open'),
      q('Q2', 'style preference', 'FLAG', 'open'),
      q('Q3', 'methodology', 'BLOCK', 'answered'),
      q('Q4', 'wave structure', 'BLOCK', 'open'),
    ];
    const blockers = checkOpenBlockers(log);
    expect(blockers).toHaveLength(2);
    expect(blockers.map((b) => b.id)).toEqual(['Q1', 'Q4']);
  });

  it('returns empty array when all BLOCK questions are answered', () => {
    const log: QuestionRecord[] = [
      q('Q1', 'scope decision', 'BLOCK', 'answered'),
      q('Q2', 'methodology', 'BLOCK', 'answered'),
    ];
    expect(checkOpenBlockers(log)).toHaveLength(0);
  });
});

describe('shouldWriteArtifact', () => {
  it('returns false when a BLOCK question is open', () => {
    const log: QuestionRecord[] = [
      q('Q1', 'scope decision', 'BLOCK', 'open'),
      q('Q2', 'style', 'FLAG', 'open'),
    ];
    expect(shouldWriteArtifact(log)).toBe(false);
  });

  it('returns true when all BLOCK questions are answered (FLAG open is OK)', () => {
    const log: QuestionRecord[] = [
      q('Q1', 'scope decision', 'BLOCK', 'answered'),
      q('Q2', 'style', 'FLAG', 'open'),
    ];
    expect(shouldWriteArtifact(log)).toBe(true);
  });

  it('returns true with empty question log', () => {
    expect(shouldWriteArtifact([])).toBe(true);
  });

  it('returns true when only FLAG questions (answered or open)', () => {
    const log: QuestionRecord[] = [
      q('Q1', 'naming preference', 'FLAG', 'open'),
      q('Q2', 'output format', 'FLAG', 'answered'),
    ];
    expect(shouldWriteArtifact(log)).toBe(true);
  });

  it('returns false when multiple BLOCK questions are open', () => {
    const log: QuestionRecord[] = [
      q('Q1', 'scope', 'BLOCK', 'open'),
      q('Q2', 'methodology', 'BLOCK', 'open'),
    ];
    expect(shouldWriteArtifact(log)).toBe(false);
  });
});
