/**
 * Install skills from GitHub: parse a `owner/repo[/subdir][#branch]` source
 * (or a full github.com URL), download the repository tarball, extract it with
 * a dependency-free ustar reader, locate directories carrying a SKILL.md, and
 * copy them into ~/.agents/skills.
 *
 * Nothing is executed from the repository — only files are copied, mirroring
 * the "download archive, copy skill dir" trust model of community installers.
 *
 * @module
 */
import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Largest accepted tarball, in bytes (50 MiB). */
export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
/** Download timeout, in milliseconds. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Parse a GitHub source reference.
 *
 * Accepted shapes: `owner/repo`, `owner/repo/subdir/deeper`, a full
 * `https://github.com/owner/repo(...)` URL (including `/tree/<branch>/<path>`
 * links), and an optional trailing `#branch`. A missing branch falls back to
 * main, then master.
 *
 * @param {string} spec - user input.
 * @returns {{ ok: true, owner: string, repo: string, subdir: string, branch: string | null } | { ok: false, error: string }}
 */
export function parseGithubSource(spec) {
  let text = String(spec ?? '').trim();
  if (text === '') return { ok: false, error: 'empty' };
  let branch = null;
  const hashAt = text.indexOf('#');
  if (hashAt >= 0) {
    branch = text.slice(hashAt + 1).trim() || null;
    text = text.slice(0, hashAt).trim();
  }
  text = text
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '');
  // `owner/repo/tree/<branch>/<path>` → branch + path.
  const treeMatch = /^([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/.exec(text);
  if (treeMatch !== null) {
    return {
      ok: true,
      owner: treeMatch[1],
      repo: treeMatch[2],
      branch: branch ?? treeMatch[3],
      subdir: treeMatch[4].replace(/^\/+|\/+$/g, ''),
    };
  }
  const parts = text.split('/').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length < 2) return { ok: false, error: 'bad-shape' };
  const [owner, repo, ...rest] = parts;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return { ok: false, error: 'bad-shape' };
  return { ok: true, owner, repo, branch, subdir: rest.join('/') };
}

/**
 * Parse an uncompressed tar buffer (ustar with optional GNU long-name
 * entries). Returns regular-file and directory entries; pax/global headers
 * are skipped.
 *
 * @param {Buffer} buffer - raw tar bytes.
 * @returns {Array<{ name: string, type: 'file' | 'dir', data: Buffer | null }>}
 */
export function parseTar(buffer) {
  /** @type {Array<{ name: string, type: 'file' | 'dir', data: Buffer | null }>} */
  const entries = [];
  let offset = 0;
  let pendingLongName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive
    const decode = (start, length) => {
      const raw = header.subarray(start, start + length);
      const nul = raw.indexOf(0);
      return raw.subarray(0, nul === -1 ? raw.length : nul).toString('utf8');
    };
    const sizeField = decode(124, 12).trim();
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) break;
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (typeFlag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'K') continue;
    const prefix = decode(345, 155);
    const baseName = decode(0, 100);
    const name = pendingLongName ?? (prefix !== '' ? `${prefix}/${baseName}` : baseName);
    pendingLongName = null;
    const normalized = name.replace(/^\.\//, '').replace(/\/+$/, '');
    if (normalized === '' || normalized === '.') continue;
    if (typeFlag === '5') entries.push({ name: normalized, type: 'dir', data: null });
    else if (typeFlag === '0' || typeFlag === '\0') entries.push({ name: normalized, type: 'file', data });
  }
  return entries;
}

/** Inflate a .tar.gz buffer and parse the tar container. */
export function parseTarGz(buffer) {
  return parseTar(gunzipSync(buffer));
}

/** Every entry is stored under a `<repo>-<ref>/` root; strip that prefix. */
function stripRoot(entries) {
  if (entries.length === 0) return entries;
  const first = entries[0].name.split('/')[0];
  if (first === '') return entries;
  return entries
    .map((entry) => ({ ...entry, name: entry.name.split('/').slice(1).join('/') }))
    .filter((entry) => entry.name !== '');
}

/**
 * Find installable skill directories in extracted entries: the repo root
 * itself, first-level directories, and `skills/<name>` directories — each
 * qualifies by carrying a direct SKILL.md child. An explicit `subdir`
 * restricts the result to that single directory.
 *
 * @param {Array<{ name: string, type: string }>} entries
 * @param {string} subdir
 * @returns {{ ok: true, candidates: Array<{ name: string, prefix: string }> } | { ok: false, error: string }}
 */
export function findSkillCandidates(entries, subdir) {
  const hasSkillMd = (prefix) => entries.some((entry) => entry.type === 'file' && entry.name === (prefix === '' ? 'SKILL.md' : `${prefix}/SKILL.md`));
  if (subdir !== '') {
    const prefix = subdir.replace(/\/+$/, '');
    if (!entries.some((entry) => entry.name === prefix || entry.name.startsWith(`${prefix}/`))) {
      return { ok: false, error: 'subdir-not-found' };
    }
    if (!hasSkillMd(prefix)) return { ok: false, error: 'no-skill-md' };
    return { ok: true, candidates: [{ name: prefix.split('/').pop(), prefix }] };
  }
  /** @type {Array<{ name: string, prefix: string }>} */
  const candidates = [];
  if (hasSkillMd('')) candidates.push({ name: '.root', prefix: '' });
  const depth1 = new Set(entries
    .filter((entry) => entry.name.includes('/'))
    .map((entry) => entry.name.split('/')[0]));
  for (const dir of [...depth1].sort()) {
    if (dir === 'skills') continue;
    if (hasSkillMd(dir)) candidates.push({ name: dir, prefix: dir });
  }
  const underSkills = new Set(entries
    .filter((entry) => entry.name.startsWith('skills/') && entry.name.split('/').length > 2)
    .map((entry) => entry.name.split('/')[1]));
  for (const dir of [...underSkills].sort()) {
    if (hasSkillMd(`skills/${dir}`)) candidates.push({ name: dir, prefix: `skills/${dir}` });
  }
  if (candidates.length === 0) return { ok: false, error: 'no-skill-md' };
  return { ok: true, candidates };
}

/** Write one candidate's files into the skills root; refuses existing targets. */
async function installCandidate(entries, candidate, skillsRoot) {
  const target = join(skillsRoot, candidate.name);
  try {
    await stat(target);
    return { name: candidate.name, status: 'exists' };
  } catch { /* absent — proceed */ }
  const files = entries.filter((entry) => entry.type === 'file'
    && (candidate.prefix === ''
      ? !entry.name.includes('/')
      : entry.name.startsWith(`${candidate.prefix}/`)));
  if (files.length === 0) return { name: candidate.name, status: 'empty' };
  for (const file of files) {
    const relative = candidate.prefix === '' ? file.name : file.name.slice(candidate.prefix.length + 1);
    if (relative.split('/').some((segment) => segment === '..')) return { name: candidate.name, status: 'bad-path' };
    const destination = join(target, relative);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, file.data);
  }
  return { name: candidate.name, status: 'installed', files: files.length };
}

/**
 * Download and install skills from one GitHub source.
 *
 * @param {object} options
 * @param {string} options.source - the user-provided GitHub path.
 * @param {string} options.skillsRoot - absolute ~/.agents/skills path.
 * @param {typeof fetch} [options.fetchImpl] - injection seam for tests.
 * @returns {Promise<{ ok: true, installed: object[], skipped: object[] } | { ok: false, error: string, message?: string }>}
 */
export async function installFromGithub(options) {
  const parsed = parseGithubSource(options.source);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { owner, repo, subdir } = parsed;
  const branches = parsed.branch !== null ? [parsed.branch] : ['main', 'master'];
  const fetchImpl = options.fetchImpl ?? fetch;

  /** @type {{ buffer: Buffer, branch: string } | null} */
  let downloaded = null;
  /** @type {string | null} */
  let lastError = null;
  for (const branch of branches) {
    const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > MAX_TARBALL_BYTES) return { ok: false, error: 'too-large' };
        downloaded = { buffer, branch };
        break;
      }
      if (response.status === 404) { lastError = 'not-found'; continue; }
      lastError = `http-${response.status}`;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (downloaded === null) {
    return { ok: false, error: lastError ?? 'download-failed', message: `github:${owner}/${repo}` };
  }

  let entries;
  try {
    entries = stripRoot(parseTarGz(downloaded.buffer));
  } catch (error) {
    return { ok: false, error: 'bad-archive', message: error instanceof Error ? error.message : String(error) };
  }
  const found = findSkillCandidates(entries, subdir);
  if (!found.ok) return { ok: false, error: found.error };

  /** @type {object[]} */
  const installed = [];
  /** @type {object[]} */
  const skipped = [];
  for (const candidate of found.candidates) {
    const name = candidate.name === '.root' ? repo : candidate.name;
    const result = await installCandidate(entries, { ...candidate, name }, options.skillsRoot);
    if (result.status === 'installed') installed.push(result);
    else skipped.push(result);
  }
  if (installed.length === 0 && skipped.length > 0) {
    return { ok: true, installed, skipped };
  }
  return { ok: true, installed, skipped };
}

/** Remove an installed skill directory (best effort) — reserved for future use. */
export async function removeSkill(skillsRoot, name) {
  await rm(join(skillsRoot, name), { recursive: true, force: true });
}
