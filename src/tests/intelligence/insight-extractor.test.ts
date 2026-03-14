import { extractInsights } from '../../intelligence/insight-extractor.js';

describe('extractInsights', () => {
  it('returns empty for short text', () => {
    expect(extractInsights('')).toEqual([]);
    expect(extractInsights('too short')).toEqual([]);
  });

  it('extracts diagnosis markers', () => {
    const text = 'After investigation, the issue is that CC sends tool_response not tool_output. This breaks all observation extraction.';
    const insights = extractInsights(text);
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights[0].marker).toBe('diagnosis');
    expect(insights[0].content).toContain('tool_response');
  });

  it('extracts finding markers', () => {
    const text = 'After checking the payload, we found that the UserPromptSubmit hook receives prompt not user_prompt. This means topic detection was dead.';
    const insights = extractInsights(text);
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights.some(i => i.marker === 'finding' || i.marker === 'diagnosis')).toBe(true);
  });

  it('extracts conclusion markers', () => {
    const text = 'After reviewing all the evidence, this confirms that the artifact TTL was draining too fast. The fix is to increase the tick interval from 5 seconds to 120 seconds.';
    const insights = extractInsights(text);
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights.some(i => i.marker === 'conclusion')).toBe(true);
  });

  it('extracts architecture markers', () => {
    const text = 'The architecture is sound but the implementation had a systemic gap. The design should separate reference and materialization layers.';
    const insights = extractInsights(text);
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights.some(i => i.marker === 'architecture')).toBe(true);
  });

  it('extracts systemic markers', () => {
    const text = 'Every hook in the system consistently fails because the field names were assumed without verification against real CC payloads.';
    const insights = extractInsights(text);
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights.some(i => i.marker === 'systemic')).toBe(true);
  });

  it('filters out filler sentences', () => {
    const text = 'Let me check the database. I see some results. The root cause is a field name mismatch between CC payload and our code.';
    const insights = extractInsights(text);
    // Should capture the root cause, not the filler
    expect(insights.every(i => !i.content.startsWith('Let me'))).toBe(true);
    expect(insights.every(i => !i.content.startsWith('I see'))).toBe(true);
  });

  it('strips code fences before extraction', () => {
    const text = 'Here is the issue:\n```typescript\nconst x = input.tool_output;\n```\nThe root cause is that CC sends tool_response not tool_output.';
    const insights = extractInsights(text);
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights[0].content).not.toContain('```');
  });

  it('strips ANSI escape codes', () => {
    const text = '\x1b[31mError:\x1b[0m The issue is that the test runner uses wrong field names throughout the codebase.';
    const insights = extractInsights(text);
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights[0].content).not.toContain('\x1b');
  });

  it('deduplicates identical insights', () => {
    // Exact same sentence repeated — should deduplicate
    const text = 'The issue is a critical field name mismatch in the hook payload system. The issue is a critical field name mismatch in the hook payload system.';
    const insights = extractInsights(text);
    expect(insights.length).toBe(1);
  });

  it('respects maxInsights limit', () => {
    const text = [
      'The issue is problem one.',
      'The problem is problem two.',
      'The bug is problem three.',
      'This is because of problem four.',
      'This means problem five exists.',
      'This happens because of problem six.',
      'Found that problem seven is real.',
    ].join(' ');
    const insights = extractInsights(text, 3);
    expect(insights.length).toBeLessThanOrEqual(3);
  });

  it('filters very short sentences', () => {
    const text = 'The issue is X. The root cause is a fundamental mismatch between assumed and actual CC hook payload field names.';
    const insights = extractInsights(text);
    // "The issue is X" is too short (< 25 chars), should be filtered
    expect(insights.every(i => i.content.length >= 25)).toBe(true);
  });

  it('handles real assistant response text', () => {
    const realResponse = `Found it. CC sends last_assistant_message, not stop_assistant_turn or assistant_text. And no user_prompt at all in the Stop payload. That's why 0 decisions — both inputs are undefined.

The root cause is a systemic field name mismatch across all CC hooks. The code assumed certain payload field names without verifying against real CC output.

This means topic shift detection, decision capture, and artifact materialization were all dead since the system was deployed.`;

    const insights = extractInsights(realResponse);
    expect(insights.length).toBeGreaterThanOrEqual(2);
    // Should capture the diagnosis and the systemic observation
    const markers = insights.map(i => i.marker);
    expect(markers).toContain('diagnosis');
  });
});
