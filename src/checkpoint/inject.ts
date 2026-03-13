/**
 * Checkpoint-to-markdown renderer for assembly pipeline injection.
 * Non-throwing — returns empty string on error.
 * @see Architecture Section 7
 */

import type { CheckpointV3, SelectiveLoadPreset } from './types.js';

/**
 * Renders a CheckpointV3 into markdown sections for assembly pipeline consumption.
 * Respects selective loading presets. Omits empty sections.
 * Non-throwing — returns empty string on error.
 */
export function renderCheckpointMarkdown(
  checkpoint: CheckpointV3,
  preset?: SelectiveLoadPreset
): string {
  try {
    if (!checkpoint) return '';

    const sections: string[] = [];
    const includeResume = !preset || preset === 'RESUME' || preset === 'GSD';
    const includeGsd = !preset || preset === 'GSD';

    // 1. Working context (always)
    const working = checkpoint.working;
    if (working && (working.task || working.status || working.next_action || working.branch)) {
      const lines: string[] = ['### Current Work'];
      if (working.task) lines.push(`- **Task:** ${working.task}`);
      if (working.status) lines.push(`- **Status:** ${working.status}`);
      if (working.next_action) lines.push(`- **Next:** ${working.next_action}`);
      if (working.branch) lines.push(`- **Branch:** ${working.branch}`);
      sections.push(lines.join('\n'));
    }

    // 2. Thread
    const thread = checkpoint.thread;
    if (thread?.topic) {
      const lines: string[] = ['### Thread', `**Topic:** ${thread.topic}`];

      if (includeResume && thread.summary) {
        lines.push(`**Summary:** ${thread.summary}`);
      }

      if (includeResume && thread.key_exchanges && thread.key_exchanges.length > 0) {
        lines.push('', '**Key Exchanges:**');
        for (const ex of thread.key_exchanges) {
          lines.push(`- **${ex.role}:** ${ex.gist}`);
        }
      }

      sections.push(lines.join('\n'));
    }

    // 3. Decisions (RESUME+)
    if (includeResume && checkpoint.decisions && checkpoint.decisions.length > 0) {
      const lines: string[] = ['### Decisions'];
      checkpoint.decisions.forEach((d, i) => {
        lines.push(`${i + 1}. [${d.source}] ${d.content}`);
      });
      sections.push(lines.join('\n'));
    }

    // 4. Files (RESUME+)
    if (includeResume && checkpoint.files) {
      const hasHot = checkpoint.files.hot && checkpoint.files.hot.length > 0;
      const hasRead = checkpoint.files.read && checkpoint.files.read.length > 0;

      if (hasHot || hasRead) {
        const lines: string[] = ['### Active Files'];

        if (hasHot) {
          lines.push('**Hot:**');
          for (const f of checkpoint.files.hot) {
            const action = f.last_action ? ` — ${f.last_action}` : '';
            lines.push(`- ${f.path}${action}`);
          }
        }

        if (hasRead) {
          if (hasHot) lines.push('');
          lines.push('**Read:**');
          for (const f of checkpoint.files.read) {
            lines.push(`- ${f}`);
          }
        }

        sections.push(lines.join('\n'));
      }
    }

    // 5. Open items (RESUME+)
    if (includeResume && checkpoint.open_items && checkpoint.open_items.length > 0) {
      const lines: string[] = ['### Open Items'];
      for (const item of checkpoint.open_items) {
        lines.push(`- ${item}`);
      }
      sections.push(lines.join('\n'));
    }

    // 6. Learnings (RESUME+)
    if (includeResume && checkpoint.learnings && checkpoint.learnings.length > 0) {
      const lines: string[] = ['### Learnings'];
      for (const learning of checkpoint.learnings) {
        lines.push(`- ${learning}`);
      }
      sections.push(lines.join('\n'));
    }

    // 7. GSD (GSD only)
    if (includeGsd && checkpoint.gsd) {
      const gsdContent =
        typeof checkpoint.gsd === 'string'
          ? checkpoint.gsd
          : JSON.stringify(checkpoint.gsd, null, 2);
      sections.push(`### GSD State\n${gsdContent}`);
    }

    return sections.join('\n\n');
  } catch {
    return '';
  }
}
