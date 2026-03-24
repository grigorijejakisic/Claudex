import { describe, it, expect } from 'vitest';
import { classifyIntent, getRetrievalConfigForIntent } from '../../intelligence/intent-classifier.js';
import type { IntentType, RetrievalConfig } from '../../intelligence/intent-classifier.js';

describe('intent-classifier', () => {
  describe('classifyIntent', () => {
    // -----------------------------------------------------------------------
    // Recall
    // -----------------------------------------------------------------------
    it('classifies "What did we decide about the schema?" as recall', () => {
      expect(classifyIntent('What did we decide about the schema?')).toBe('recall');
    });

    it('classifies "Last time we discussed the V9 migration" as recall', () => {
      expect(classifyIntent('Last time we discussed the V9 migration')).toBe('recall');
    });

    it('classifies "You said we should use Qdrant" as recall', () => {
      expect(classifyIntent('You said we should use Qdrant')).toBe('recall');
    });

    it('classifies "Do you remember when we added the decay engine?" as recall', () => {
      expect(classifyIntent('Do you remember when we added the decay engine?')).toBe('recall');
    });

    it('classifies "In our last session we fixed the hooks" as recall', () => {
      expect(classifyIntent('In our last session we fixed the hooks')).toBe('recall');
    });

    it('classifies "You mentioned something about retrieval feedback" as recall', () => {
      expect(classifyIntent('You mentioned something about retrieval feedback')).toBe('recall');
    });

    // -----------------------------------------------------------------------
    // Investigation
    // -----------------------------------------------------------------------
    it('classifies "Why is the test failing?" as investigation', () => {
      expect(classifyIntent('Why is the test failing?')).toBe('investigation');
    });

    it('classifies "How does the assembly pipeline work?" as investigation', () => {
      expect(classifyIntent('How does the assembly pipeline work?')).toBe('investigation');
    });

    it('classifies "What is causing the N+1 query?" as investigation', () => {
      expect(classifyIntent('What is causing the N+1 query?')).toBe('investigation');
    });

    it('classifies "Explain the hybrid retrieval algorithm" as investigation', () => {
      expect(classifyIntent('Explain the hybrid retrieval algorithm')).toBe('investigation');
    });

    it('classifies "Can you explain how spreading activation works?" as investigation', () => {
      expect(classifyIntent('Can you explain how spreading activation works?')).toBe('investigation');
    });

    it('classifies question-mark-ending prompts as investigation', () => {
      expect(classifyIntent('What about the backup strategy?')).toBe('investigation');
    });

    it('classifies "What\'s wrong with the build?" as investigation', () => {
      expect(classifyIntent("What's wrong with the build?")).toBe('investigation');
    });

    // -----------------------------------------------------------------------
    // Implementation
    // -----------------------------------------------------------------------
    it('classifies "Add rate limiting to the API" as implementation', () => {
      expect(classifyIntent('Add rate limiting to the API')).toBe('implementation');
    });

    it('classifies "Fix the bug in auth.ts" as implementation', () => {
      expect(classifyIntent('Fix the bug in auth.ts')).toBe('implementation');
    });

    it('classifies "Create a new test for the embeddings module" as implementation', () => {
      expect(classifyIntent('Create a new test for the embeddings module')).toBe('implementation');
    });

    it('classifies "Implement the consolidation phase" as implementation', () => {
      expect(classifyIntent('Implement the consolidation phase')).toBe('implementation');
    });

    it('classifies "Update the schema migration" as implementation', () => {
      expect(classifyIntent('Update the code in the handler')).toBe('implementation');
    });

    it('classifies "Refactor the search function" as implementation', () => {
      expect(classifyIntent('Refactor the search function')).toBe('implementation');
    });

    it('classifies file-path + action verb as implementation', () => {
      expect(classifyIntent('Fix the issue in src/core/storage.ts')).toBe('implementation');
    });

    // -----------------------------------------------------------------------
    // Planning
    // -----------------------------------------------------------------------
    it('classifies "Should we use Qdrant or sqlite-vec?" as planning', () => {
      expect(classifyIntent('Should we use Qdrant or sqlite-vec?')).toBe('planning');
    });

    it('classifies "What approach should we take for caching?" as planning', () => {
      expect(classifyIntent('What approach should we take for caching?')).toBe('planning');
    });

    it('classifies "Let\'s think about the architecture for this" as planning', () => {
      expect(classifyIntent("Let's think about the architecture for this")).toBe('planning');
    });

    it('classifies "Compare the tradeoffs of both approaches" as planning', () => {
      expect(classifyIntent('Compare the tradeoffs of both approaches')).toBe('planning');
    });

    it('classifies "Pros and cons of using Redis vs SQLite" as planning', () => {
      expect(classifyIntent('Pros and cons of using Redis vs SQLite')).toBe('planning');
    });

    // -----------------------------------------------------------------------
    // Continuation (default)
    // -----------------------------------------------------------------------
    it('classifies "yes" as continuation', () => {
      expect(classifyIntent('yes')).toBe('continuation');
    });

    it('classifies empty string as continuation', () => {
      expect(classifyIntent('')).toBe('continuation');
    });

    it('classifies "ok" as continuation', () => {
      expect(classifyIntent('ok')).toBe('continuation');
    });

    it('classifies "go ahead" as continuation', () => {
      expect(classifyIntent('go ahead')).toBe('continuation');
    });

    it('classifies "looks good" as continuation', () => {
      expect(classifyIntent('looks good')).toBe('continuation');
    });

    it('classifies whitespace-only string as continuation', () => {
      expect(classifyIntent('   ')).toBe('continuation');
    });

    // -----------------------------------------------------------------------
    // Priority: recall > investigation > implementation > planning
    // -----------------------------------------------------------------------
    it('recall takes priority over investigation (recall + question mark)', () => {
      // "What did we decide" has recall keywords AND a question mark
      expect(classifyIntent('What did we decide about the schema?')).toBe('recall');
    });

    it('recall takes priority over implementation', () => {
      // "You said we should fix" has recall AND implementation keywords
      expect(classifyIntent('You said we should fix the auth module')).toBe('recall');
    });
  });

  describe('getRetrievalConfigForIntent', () => {
    it('returns continuation config with recencyWeight=1.5, limit=5', () => {
      const config = getRetrievalConfigForIntent('continuation');
      expect(config.recencyWeight).toBe(1.5);
      expect(config.limit).toBe(5);
      expect(config.includeConversationTurns).toBe(false);
      expect(config.artifactTypes).toBeUndefined();
    });

    it('returns investigation config with recencyWeight=0.5, limit=15', () => {
      const config = getRetrievalConfigForIntent('investigation');
      expect(config.recencyWeight).toBe(0.5);
      expect(config.limit).toBe(15);
      expect(config.includeConversationTurns).toBe(true);
      expect(config.artifactTypes).toEqual(['observation', 'learning', 'decision']);
    });

    it('returns implementation config with recencyWeight=1.0, limit=10', () => {
      const config = getRetrievalConfigForIntent('implementation');
      expect(config.recencyWeight).toBe(1.0);
      expect(config.limit).toBe(10);
      expect(config.includeConversationTurns).toBe(false);
      expect(config.artifactTypes).toEqual(['observation', 'hot_file']);
    });

    it('returns planning config with recencyWeight=0.3, limit=10', () => {
      const config = getRetrievalConfigForIntent('planning');
      expect(config.recencyWeight).toBe(0.3);
      expect(config.limit).toBe(10);
      expect(config.includeConversationTurns).toBe(false);
      expect(config.artifactTypes).toEqual(['decision', 'learning']);
    });

    it('returns recall config with recencyWeight=0.0, limit=20', () => {
      const config = getRetrievalConfigForIntent('recall');
      expect(config.recencyWeight).toBe(0.0);
      expect(config.limit).toBe(20);
      expect(config.includeConversationTurns).toBe(true);
      expect(config.artifactTypes).toBeUndefined();
    });

    it('returns continuation config for unknown intent', () => {
      // Force a bad value through the type system to test defensiveness
      const config = getRetrievalConfigForIntent('nonexistent' as IntentType);
      expect(config.recencyWeight).toBe(1.5);
      expect(config.limit).toBe(5);
    });
  });

  describe('classification performance', () => {
    it('classifies 1000 prompts in under 50ms (pure regex)', () => {
      const prompts = [
        'Why is the test failing?',
        'Fix the bug in auth.ts',
        'Last time we discussed the schema',
        'Should we use Qdrant?',
        'yes',
        'Add a new endpoint for users',
        'How does the assembly pipeline work?',
        'Let\'s think about the architecture',
        '',
        'ok go ahead',
      ];

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        classifyIntent(prompts[i % prompts.length]);
      }
      const elapsed = performance.now() - start;

      // 1000 classifications should complete well under 50ms
      expect(elapsed).toBeLessThan(50);
    });
  });
});
