/**
 * Cross-cutting tests for all 10 per-tool extractors.
 * Verifies shared invariants: null on empty input, content truncation.
 */

import { extractRead } from '../../../extraction/extractors/read.js';
import { extractEdit } from '../../../extraction/extractors/edit.js';
import { extractWrite } from '../../../extraction/extractors/write.js';
import { extractBash } from '../../../extraction/extractors/bash.js';
import { extractGrep } from '../../../extraction/extractors/grep.js';
import { extractGlob } from '../../../extraction/extractors/glob.js';
import { extractWebFetch } from '../../../extraction/extractors/web-fetch.js';
import { extractWebSearch } from '../../../extraction/extractors/web-search.js';
import { extractTask } from '../../../extraction/extractors/task.js';
import { extractNotebookEdit } from '../../../extraction/extractors/notebook-edit.js';
import { CONTENT_MAX_CHARS } from '../../../shared/constants.js';

describe('all extractors', () => {
  const extractors = [
    { name: 'extractRead', fn: extractRead },
    { name: 'extractEdit', fn: extractEdit },
    { name: 'extractWrite', fn: extractWrite },
    { name: 'extractBash', fn: extractBash },
    { name: 'extractGrep', fn: extractGrep },
    { name: 'extractGlob', fn: extractGlob },
    { name: 'extractWebFetch', fn: extractWebFetch },
    { name: 'extractWebSearch', fn: extractWebSearch },
    { name: 'extractTask', fn: extractTask },
    { name: 'extractNotebookEdit', fn: extractNotebookEdit },
  ];

  it('return null on empty/malformed input', () => {
    for (const { fn } of extractors) {
      expect(fn({}, undefined)).toBeNull();
    }
  });

  it(`truncate content at CONTENT_MAX_CHARS (${CONTENT_MAX_CHARS}) chars`, () => {
    const longContent = 'a'.repeat(5000);

    // Test a few extractors with long content
    const readResult = extractRead(
      { file_path: '/src/file.ts' },
      { content: longContent }
    );
    expect(readResult).not.toBeNull();
    expect(readResult!.content.length).toBeLessThanOrEqual(CONTENT_MAX_CHARS + 3); // + "..."

    const writeResult = extractWrite(
      { file_path: '/src/file.ts', content: longContent },
      undefined
    );
    expect(writeResult).not.toBeNull();
    expect(writeResult!.content.length).toBeLessThanOrEqual(CONTENT_MAX_CHARS + 3);

    const bashResult = extractBash(
      { command: 'cat big.log' },
      { output: longContent }
    );
    expect(bashResult).not.toBeNull();
    expect(bashResult!.content.length).toBeLessThanOrEqual(CONTENT_MAX_CHARS + 3);
  });
});
