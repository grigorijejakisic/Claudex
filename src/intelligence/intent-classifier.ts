/**
 * Intent Classifier — rule-based user prompt intent detection.
 *
 * Classifies prompts into 5 intent types using pure regex/keyword matching.
 * No ML, no embeddings, no LLM calls — must complete in <1ms.
 *
 * Classification order (first match wins):
 *   1. recall — references to past conversations/sessions
 *   2. investigation — questions, explanations, debugging
 *   3. implementation — imperative actions on code/files
 *   4. planning — architecture/design/strategy discussions
 *   5. continuation — default fallback (safest)
 *
 * Each intent maps to a RetrievalConfig that tunes hybrid search behavior.
 * All public functions are non-throwing with safe defaults.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntentType = 'continuation' | 'investigation' | 'implementation' | 'planning' | 'recall';

export interface RetrievalConfig {
  /** Filter artifacts by type. undefined = all types. */
  artifactTypes?: string[];
  /** Recency weight multiplier for scoring. Higher = favor recent. */
  recencyWeight: number;
  /** Maximum results to return from search. */
  limit: number;
  /** Whether to include conversation turn history in search. */
  includeConversationTurns: boolean;
}

// ---------------------------------------------------------------------------
// Classification rules (compiled once at module load)
// ---------------------------------------------------------------------------

/**
 * Recall — user references past conversations, sessions, or shared history.
 * Anchored at word boundary to avoid false positives on substrings.
 */
const RECALL_RE = /\b(last time|remember when|we discussed|you said|you mentioned|previous session|earlier session|we decide[d]?|we agreed|you told me|you recommended|do you recall|from before|last session|in our last|when we last)\b/i;

/**
 * Investigation — questions, debugging, explanation requests.
 * These are specific interrogative patterns — the generic question mark
 * fallback is handled separately AFTER planning check.
 */
const INVESTIGATION_RE = /\b(why\s+(is|does|did|are|was|do|doesn't|isn't|won't|can't|would)|how\s+(does|do|did|is|can|to|would)|what\s+(is|are|does|did|causes|caused|happened|went)|explain\s|where\s+(is|does|did|are)|can\s+you\s+explain|tell\s+me\s+(about|why|how)|debug|diagnose|investigate|trace\s+the|root\s+cause|what('s|\s+is)\s+(wrong|happening|going\s+on|the\s+(issue|error|problem|bug)))\b/i;

/** Standalone question mark — weaker investigation signal, checked AFTER planning. */
const QUESTION_MARK_RE = /\?\s*$/;

/**
 * Implementation — imperative actions on code, files, or systems.
 * Two tiers: specific noun patterns and general imperative verbs.
 */
const IMPLEMENTATION_SPECIFIC_RE = /\b(add\s+(?:a\s+)?(?:new\s+)?(?:function|method|class|file|module|test|endpoint|route|handler|field|column|table|component|hook)|create\s+(?:a\s+)?(?:new\s+)?(?:function|method|class|file|module|test|endpoint|route|handler|field|column|table|component|hook)|fix\s+(?:the\s+)?(?:bug|error|issue|problem|crash|failure|test|build)|update\s+(?:the\s+)?(?:code|function|method|class|file|module|test|schema|config|handler)|delete\s+(?:the\s+)?(?:function|method|class|file|module|test|endpoint)|write\s+(?:a\s+)?(?:test|function|method|class|module)|modify\s+(?:the\s+)?(?:function|method|class|file|code|logic|behavior)|change\s+(?:the\s+)?(?:function|method|class|file|code|logic|behavior)|remove\s+(?:the\s+)?(?:function|method|class|file|module|code|import|export))\b/i;

/**
 * Implementation — general imperative verbs that start a sentence.
 * These are broad but anchored to sentence start to reduce false positives.
 */
const IMPLEMENTATION_IMPERATIVE_RE = /^(add|create|fix|implement|refactor|update|delete|rename|move|write|modify|change|remove)\s/i;

/** File path patterns — strong implementation signal when combined with action verbs. */
const FILE_PATH_RE = /(?:^|\s)(?:src|lib|test|dist|node_modules)\/\S+\.\w{1,5}\b|\.(?:ts|js|tsx|jsx|py|rs|go|rb|java|c|cpp|h|css|scss|html|sql|yaml|yml|json|toml)\b/i;

/**
 * Planning — architecture, design, strategy, tradeoffs.
 */
const PLANNING_RE = /\b(should\s+we|what\s+(?:approach|strategy|architecture|design)|let'?s\s+(?:think|plan|consider|discuss|design)|trade\s*off|pros?\s+and\s+cons?|architecture|design\s+(?:pattern|decision|approach)|strategy\s+for|how\s+should\s+we|which\s+(?:approach|pattern|tool|library|framework)|compare\s|weigh\s+(?:the\s+)?(?:options|alternatives|approaches)|planning\s|roadmap|milestone)\b/i;

// ---------------------------------------------------------------------------
// Retrieval configs (static, immutable)
// ---------------------------------------------------------------------------

const RETRIEVAL_CONFIGS: Record<IntentType, RetrievalConfig> = {
  continuation: {
    recencyWeight: 1.5,
    limit: 5,
    includeConversationTurns: false,
  },
  investigation: {
    artifactTypes: ['observation', 'learning', 'decision'],
    recencyWeight: 0.5,
    limit: 15,
    includeConversationTurns: true,
  },
  implementation: {
    artifactTypes: ['observation', 'hot_file'],
    recencyWeight: 1.0,
    limit: 10,
    includeConversationTurns: false,
  },
  planning: {
    artifactTypes: ['decision', 'learning'],
    recencyWeight: 0.3,
    limit: 10,
    includeConversationTurns: false,
  },
  recall: {
    recencyWeight: 0.0,
    limit: 20,
    includeConversationTurns: true,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify user prompt intent using rule-based pattern matching.
 *
 * Classification order (first match wins):
 *   recall → investigation → implementation → planning → continuation
 *
 * Non-throwing — returns 'continuation' on any error.
 * Performance: pure regex, <1ms.
 */
export function classifyIntent(prompt: string): IntentType {
  try {
    if (!prompt || prompt.trim().length === 0) return 'continuation';

    const trimmed = prompt.trim();

    // 1. Recall — highest priority, explicit memory references
    if (RECALL_RE.test(trimmed)) return 'recall';

    // 2. Investigation — specific interrogative patterns (not question-mark fallback)
    if (INVESTIGATION_RE.test(trimmed)) return 'investigation';

    // 3. Implementation — code actions, file operations
    if (IMPLEMENTATION_SPECIFIC_RE.test(trimmed)) return 'implementation';
    if (IMPLEMENTATION_IMPERATIVE_RE.test(trimmed)) return 'implementation';
    if (FILE_PATH_RE.test(trimmed) && /\b(fix|add|create|update|modify|change|implement|write|delete|remove|refactor|rename|move)\b/i.test(trimmed)) return 'implementation';

    // 4. Planning — architecture, design, strategy
    // Checked BEFORE question-mark fallback so "Should we use X?" → planning, not investigation
    if (PLANNING_RE.test(trimmed)) return 'planning';

    // 5. Question mark fallback — prompts ending in ? that didn't match above
    // This is a weaker investigation signal, only fires after planning is ruled out
    if (QUESTION_MARK_RE.test(trimmed) && trimmed.length > 5) return 'investigation';

    // 6. Default — continuation (safest)
    return 'continuation';
  } catch {
    return 'continuation';
  }
}

/**
 * Get retrieval configuration for a classified intent.
 *
 * Returns a frozen config object — callers must not mutate.
 * Non-throwing — returns continuation config on any error.
 */
export function getRetrievalConfigForIntent(intent: IntentType): RetrievalConfig {
  try {
    return RETRIEVAL_CONFIGS[intent] ?? RETRIEVAL_CONFIGS.continuation;
  } catch {
    return RETRIEVAL_CONFIGS.continuation;
  }
}
