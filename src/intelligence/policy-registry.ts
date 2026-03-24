/**
 * Policy Registry — singleton holder for the active MemoryPolicy.
 *
 * Starts with DefaultMemoryPolicy. Can be swapped at runtime
 * (e.g., for RL-trained policies or testing).
 */

import type { MemoryPolicy } from './memory-policy.js';
import { DefaultMemoryPolicy } from './default-policy.js';

let activePolicy: MemoryPolicy = new DefaultMemoryPolicy();

/** Returns the currently active memory policy. */
export function getPolicy(): MemoryPolicy {
  return activePolicy;
}

/** Sets a custom memory policy (replaces the active one). */
export function setPolicy(policy: MemoryPolicy): void {
  activePolicy = policy;
}

/** Resets to the default policy (current hard-coded rules). */
export function resetToDefault(): void {
  activePolicy = new DefaultMemoryPolicy();
}
