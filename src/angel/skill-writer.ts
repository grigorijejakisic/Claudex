/**
 * Shared SKILL.md read/write utility for Angel skill operations.
 *
 * Used by A8 (correction-to-skill amendment) and A10 (pattern-to-skill crystallization).
 * Handles frontmatter parsing, path resolution, and dedup checks.
 *
 * Non-throwing — returns false/null on failure.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SkillFile {
  when_to_use: string;
  body: string;
}

/**
 * Parse a SKILL.md file into frontmatter + body.
 * Frontmatter is `---` delimited YAML with at least `when_to_use`.
 */
export function readSkillFile(filePath: string): SkillFile | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parts = content.split(/^---\s*$/m);
    if (parts.length < 3) return null;
    // parts[0] is empty (before first ---), parts[1] is frontmatter, parts[2+] is body
    const frontmatter = parts[1];
    const body = parts.slice(2).join('---');
    const whenMatch = frontmatter.match(/when_to_use:\s*"?([^"\n]+)"?/);
    return {
      when_to_use: whenMatch?.[1]?.trim() ?? '',
      body: body.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the skills directory for a project.
 * Skills live at `<project_root>/.claude/skills/` or `~/.claude/skills/` as fallback.
 */
function resolveSkillsDir(projectRoot?: string): string {
  if (projectRoot) return path.join(projectRoot, '.claude', 'skills');
  return path.join(os.homedir(), '.claude', 'skills');
}

/**
 * Find an existing SKILL.md whose `when_to_use` matches a domain keyword.
 * Simple keyword match — checks if the domain appears in the skill's when_to_use.
 */
export function findSkillByDomain(
  skillsDir: string,
  domain: string,
): { path: string; skill: SkillFile } | null {
  try {
    if (!fs.existsSync(skillsDir)) return null;
    const dirs = fs.readdirSync(skillsDir, { withFileTypes: true });
    const domainLower = domain.toLowerCase();
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const skillPath = path.join(skillsDir, dir.name, 'SKILL.md');
      const skill = readSkillFile(skillPath);
      if (!skill) continue;
      // Match: domain keyword in when_to_use OR directory name matches domain
      if (skill.when_to_use.toLowerCase().includes(domainLower) || dir.name.toLowerCase() === domainLower) {
        return { path: skillPath, skill };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write a SKILL.md file.
 *
 * - `create`: write new file. Skips if file already exists (dedup).
 * - `amend`: append content to existing file.
 *
 * Returns true on success.
 */
export function writeSkillFile(
  domain: string,
  content: { when_to_use: string; body: string },
  mode: 'create' | 'amend',
  projectRoot?: string,
): boolean {
  try {
    const skillsDir = resolveSkillsDir(projectRoot);
    // Sanitize domain for directory name
    const safeDomain = domain.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
    const dirPath = path.join(skillsDir, safeDomain);
    const filePath = path.join(dirPath, 'SKILL.md');

    if (mode === 'create') {
      if (fs.existsSync(filePath)) return false; // Dedup: already exists
      fs.mkdirSync(dirPath, { recursive: true });
      const fileContent = `---\nwhen_to_use: "${content.when_to_use}"\n---\n\n${content.body}\n`;
      fs.writeFileSync(filePath, fileContent, 'utf-8');
      return true;
    }

    if (mode === 'amend') {
      if (!fs.existsSync(filePath)) return false; // Nothing to amend
      const existing = fs.readFileSync(filePath, 'utf-8');
      const amended = existing.trimEnd() + '\n\n' + content.body + '\n';
      fs.writeFileSync(filePath, amended, 'utf-8');
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
