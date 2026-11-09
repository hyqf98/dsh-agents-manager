/**
 * ~/.agents/skills store: discovery, frontmatter parsing, and checked file
 * read/write for the in-page skill editor.
 *
 * @module
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';

/** Skill directory name contract: a safe path segment (no leading dot). */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** Files above this size are read-only in the editor. */
export const MAX_EDITABLE_BYTES = 1024 * 1024;

/**
 * Extract `name` and `description` from a SKILL.md body's YAML-ish frontmatter.
 * Only the simple `key: value` shape used by skill files is supported; parse
 * failures degrade to empty fields rather than throwing.
 *
 * @param {string} text - SKILL.md content.
 * @returns {{ name: string | null, description: string | null }}
 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return { name: null, description: null };
  const block = match[1];
  /** @type {string | null} */
  let name = null;
  /** @type {string | null} */
  let description = null;
  for (const line of block.split(/\r?\n/)) {
    const nameMatch = /^name:\s*(.*)$/.exec(line);
    if (nameMatch !== null && name === null) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const descMatch = /^description:\s*(.*)$/.exec(line);
    if (descMatch !== null && description === null) {
      description = descMatch[1].trim().replace(/^["']|["']$/g, '');
      if (description === '' || description === '>' || description === '|') description = '';
      else if (description.endsWith('>-') || description.endsWith('|-')) {
        description = description.slice(0, -2).trim();
      }
    }
  }
  return { name, description };
}

/** One directory entry flattened during the walk. */

/**
 * Walk one skill directory collecting relative file paths and sizes. Hidden
 * entries (dot-prefixed) and node_modules are skipped. Depth is bounded.
 *
 * @param {string} skillDir - absolute skill directory.
 * @returns {Promise<Array<{ path: string, bytes: number }>>}
 */
export async function listSkillFiles(skillDir) {
  /** @type {Array<{ path: string, bytes: number }>} */
  const files = [];
  const MAX_DEPTH = 6;
  /**
   * @param {string} dir
   * @param {string} prefix
   * @param {number} depth
   */
  async function walk(dir, prefix, depth) {
    if (depth > MAX_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        const info = await stat(join(dir, entry.name));
        files.push({ path: rel, bytes: info.size });
      }
    }
  }
  await walk(skillDir, '', 0);
  return files;
}

/**
 * List every skill under the root: directory name, frontmatter identity, and
 * its file count. Directories without SKILL.md are still listed (marked) so
 * the UI can show what sits in ~/.agents/skills.
 *
 * @param {string} rootDir - absolute skills root (~/.agents/skills).
 * @returns {Promise<{ ok: true, skills: Array<object> } | { ok: false, error: string }>}
 */
export async function listSkills(rootDir) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT') return { ok: true, skills: [] };
    return { ok: false, error: `read-failed:${code ?? 'unknown'}` };
  }
  /** @type {Array<object>} */
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(rootDir, entry.name);
    /** @type {{ name: string | null, description: string | null }} */
    let meta = { name: null, description: null };
    let hasSkillMd = false;
    let fileCount = 0;
    try {
      const skillText = await readFile(join(dir, 'SKILL.md'), 'utf8');
      hasSkillMd = true;
      meta = parseFrontmatter(skillText);
      fileCount = (await listSkillFiles(dir)).length;
    } catch { /* unreadable skill still listed with empty meta */ }
    skills.push({
      dir: entry.name,
      name: meta.name ?? entry.name,
      description: meta.description ?? '',
      hasSkillMd,
      fileCount,
    });
  }
  skills.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { ok: true, skills };
}

/**
 * Resolve and validate an (skill, relative path) pair under the skills root.
 * Rejects traversal and absolute paths before any filesystem access.
 *
 * @param {string} rootDir - absolute skills root.
 * @param {string} skillName - skill directory name.
 * @param {string} relPath - relative file path inside the skill directory.
 * @returns {{ ok: true, absolute: string } | { ok: false, error: string }}
 */
export function resolveSkillFile(rootDir, skillName, relPath) {
  if (!SKILL_NAME_PATTERN.test(skillName)) return { ok: false, error: 'bad-skill-name' };
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0')) {
    return { ok: false, error: 'bad-path' };
  }
  const root = resolve(rootDir, skillName);
  const absolute = resolve(root, relPath);
  if (absolute !== root && !absolute.startsWith(root + sep)) return { ok: false, error: 'traversal' };
  return { ok: true, absolute };
}

/**
 * Read one skill file for the editor: content, sha256 version, and editability.
 *
 * @param {string} rootDir - absolute skills root.
 * @param {string} skillName - skill directory name.
 * @param {string} relPath - relative file path.
 * @returns {Promise<{ ok: true, file: object } | { ok: false, error: string }>}
 */
export async function readSkillFile(rootDir, skillName, relPath) {
  const resolved = resolveSkillFile(rootDir, skillName, relPath);
  if (!resolved.ok) return resolved;
  let info;
  try {
    info = await stat(resolved.absolute);
  } catch {
    return { ok: false, error: 'not-found' };
  }
  if (!info.isFile()) return { ok: false, error: 'not-a-file' };
  if (info.size > MAX_EDITABLE_BYTES) {
    return { ok: true, file: { skill: skillName, path: relPath, bytes: info.size, editable: false, reason: 'too-large', content: '', sha: '' } };
  }
  const buffer = await readFile(resolved.absolute);
  if (buffer.includes(0)) {
    return { ok: true, file: { skill: skillName, path: relPath, bytes: info.size, editable: false, reason: 'binary', content: '', sha: '' } };
  }
  const content = buffer.toString('utf8');
  const sha = createHash('sha256').update(buffer).digest('hex');
  return { ok: true, file: { skill: skillName, path: relPath, bytes: info.size, editable: true, reason: '', content, sha } };
}

/**
 * Write one skill file with optimistic concurrency: the request carries the
 * sha256 the editor loaded; a mismatch is a conflict, not a silent overwrite.
 *
 * @param {string} rootDir - absolute skills root.
 * @param {string} skillName - skill directory name.
 * @param {string} relPath - relative file path.
 * @param {string} content - full replacement content.
 * @param {string | null} baseSha - sha256 the caller loaded, or null to force.
 * @returns {Promise<{ ok: true, sha: string } | { ok: false, error: string }>}
 */
export async function writeSkillFile(rootDir, skillName, relPath, content, baseSha) {
  const resolved = resolveSkillFile(rootDir, skillName, relPath);
  if (!resolved.ok) return resolved;
  if (typeof content !== 'string') return { ok: false, error: 'bad-content' };
  if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_BYTES) return { ok: false, error: 'too-large' };
  try {
    if (baseSha !== null) {
      let current;
      try {
        current = await readFile(resolved.absolute);
      } catch {
        return { ok: false, error: 'not-found' };
      }
      if (current.length > MAX_EDITABLE_BYTES) return { ok: false, error: 'too-large' };
      const currentSha = createHash('sha256').update(current).digest('hex');
      if (currentSha !== baseSha) return { ok: false, error: 'conflict' };
    }
    await writeFile(resolved.absolute, content, 'utf8');
    const sha = createHash('sha256').update(content, 'utf8').digest('hex');
    return { ok: true, sha };
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error).message };
  }
}
