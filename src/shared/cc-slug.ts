/**
 * Compute CC project directory slug from a filesystem path.
 *
 * Claude Code encodes a project path into a directory name under
 * `~/.claude/projects/` by replacing separators, colons, dots, and spaces
 * with dashes. This helper matches that encoding so Claudex can resolve
 * the CC project directory for any given absolute path.
 */
export function pathToCcSlug(projectPath: string): string {
  return projectPath.replace(/[:\\/. ]/g, '-');
}
