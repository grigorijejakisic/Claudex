import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/cm-adapter/state-files.js', () => ({
  batchAppendOpenItems: vi.fn(),
}));

import { scanAndCaptureOpenItems } from '../../src/cm-adapter/open-items.js';
import { batchAppendOpenItems } from '../../src/cm-adapter/state-files.js';

const mockBatchAppend = vi.mocked(batchAppendOpenItems);

describe('scanAndCaptureOpenItems', () => {
  beforeEach(() => {
    mockBatchAppend.mockReset();
  });

  it('captures unchecked checkbox items', async () => {
    await scanAndCaptureOpenItems('test-session', '- [ ] TODO item here');
    expect(mockBatchAppend).toHaveBeenCalledTimes(1);
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', ['- [ ] TODO item here']);
  });

  it('captures indented unchecked checkboxes', async () => {
    await scanAndCaptureOpenItems('test-session', '  - [ ] nested checkbox');
    expect(mockBatchAppend).toHaveBeenCalledTimes(1);
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', ['- [ ] nested checkbox']);
  });

  it('captures bullet with action keyword "need to"', async () => {
    await scanAndCaptureOpenItems('test-session', '- need to fix the parser');
    expect(mockBatchAppend).toHaveBeenCalledTimes(1);
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', ['- need to fix the parser']);
  });

  it('captures numbered item with action keyword "TODO"', async () => {
    await scanAndCaptureOpenItems('test-session', '1. TODO: implement dedup');
    expect(mockBatchAppend).toHaveBeenCalledTimes(1);
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', ['1. TODO: implement dedup']);
  });

  it('captures bullet with "FIXME"', async () => {
    await scanAndCaptureOpenItems('test-session', '- FIXME broken edge case');
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', ['- FIXME broken edge case']);
  });

  it('captures bullet with "still need"', async () => {
    await scanAndCaptureOpenItems('test-session', '* still need to verify output');
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', ['* still need to verify output']);
  });

  it('does NOT capture bullet WITHOUT action keyword', async () => {
    await scanAndCaptureOpenItems('test-session', '- just a regular note');
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', []);
  });

  it('does NOT capture plain text with action keyword (not bullet)', async () => {
    await scanAndCaptureOpenItems('test-session', 'We need to fix the parser');
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', []);
  });

  it('does NOT capture content inside code fences', async () => {
    const text = [
      '```',
      '- [ ] TODO this is code',
      '- need to fix this in code',
      '```',
    ].join('\n');
    await scanAndCaptureOpenItems('test-session', text);
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', []);
  });

  it('truncates long items to 147 chars + "..."', async () => {
    const longItem = '- [ ] ' + 'x'.repeat(200);
    await scanAndCaptureOpenItems('test-session', longItem);
    const captured = mockBatchAppend.mock.calls[0]![1];
    expect(captured.length).toBe(1);
    expect(captured[0]!.length).toBe(150);
    expect(captured[0]!.endsWith('...')).toBe(true);
  });

  it('does not truncate items at or under 150 chars', async () => {
    const item = '- [ ] ' + 'x'.repeat(140);
    await scanAndCaptureOpenItems('test-session', item);
    const captured = mockBatchAppend.mock.calls[0]![1];
    expect(captured.length).toBe(1);
    expect(captured[0]!.length).toBeLessThanOrEqual(150);
    expect(captured[0]!.endsWith('...')).toBe(false);
  });

  it('calls batchAppendOpenItems with empty array for empty text', async () => {
    await scanAndCaptureOpenItems('test-session', '');
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', []);
  });

  it('collects multiple matches in single batch call', async () => {
    const text = [
      '- [ ] First TODO',
      '- need to fix second thing',
      '- just a note',
      '- [ ] Third checkbox',
    ].join('\n');
    await scanAndCaptureOpenItems('test-session', text);
    expect(mockBatchAppend).toHaveBeenCalledTimes(1);
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', [
      '- [ ] First TODO',
      '- need to fix second thing',
      '- [ ] Third checkbox',
    ]);
  });

  it('filters out items containing secret patterns', async () => {
    const text = [
      '- [ ] TODO set token= sk-abcdefghijklmnopqrstuvwx',
      '- [ ] TODO fix the parser',
      '- need to update password= hunter2',
      '- [ ] TODO check AKIAIOSFODNN7EXAMPLE key',
    ].join('\n');
    await scanAndCaptureOpenItems('test-session', text);
    expect(mockBatchAppend).toHaveBeenCalledTimes(1);
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', [
      '- [ ] TODO fix the parser',
    ]);
  });

  it('filters out items with GitHub personal access tokens', async () => {
    await scanAndCaptureOpenItems('test-session', '- [ ] TODO use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(mockBatchAppend).toHaveBeenCalledTimes(1);
    expect(mockBatchAppend).toHaveBeenCalledWith('test-session', []);
  });
});
