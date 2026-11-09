import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  parseGithubSource,
  parseTar,
  findSkillCandidates,
  installFromGithub,
} from '../../src/host/skills/installer.js';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Build one ustar header block. */
function tarHeader(name, size, typeFlag) {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write(typeFlag, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  // Checksum: spaces while computing.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

/** Build a tar buffer from [name, content, typeFlag] entries. */
function buildTar(files) {
  const chunks = [];
  const pushData = (data) => {
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  };
  for (const [name, content, typeFlag = '0'] of files) {
    const data = typeFlag === '5' ? Buffer.alloc(0) : Buffer.from(content, 'utf8');
    if (name.length > 100) {
      // GNU long-name entry first: its data is the real name + NUL.
      const longData = Buffer.concat([Buffer.from(name, 'utf8'), Buffer.alloc(1)]);
      chunks.push(tarHeader('././@LongLink', longData.length, 'L'));
      pushData(longData);
      chunks.push(tarHeader(name.slice(0, 100), data.length, typeFlag));
    } else {
      chunks.push(tarHeader(name, data.length, typeFlag));
    }
    pushData(data);
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

test('parseGithubSource accepts repo, subdir, URL, tree links, and branches', () => {
  assert.deepEqual(parseGithubSource('owner/repo'), { ok: true, owner: 'owner', repo: 'repo', branch: null, subdir: '' });
  assert.deepEqual(parseGithubSource('owner/repo/some/deep/dir'), { ok: true, owner: 'owner', repo: 'repo', branch: null, subdir: 'some/deep/dir' });
  assert.deepEqual(parseGithubSource('https://github.com/o/r/tree/dev/skills/my-skill'), { ok: true, owner: 'o', repo: 'r', branch: 'dev', subdir: 'skills/my-skill' });
  assert.deepEqual(parseGithubSource('https://github.com/o/r.git#v2'), { ok: true, owner: 'o', repo: 'r', branch: 'v2', subdir: '' });
  assert.equal(parseGithubSource('justone').ok, false);
  assert.equal(parseGithubSource('   ').ok, false);
});

test('parseTar reads ustar files, dirs, and GNU long names', () => {
  const longName = 'a-very-long-directory-name-exceeding-one-hundred-characters-in-total/' + 'x'.repeat(40) + '/SKILL.md';
  const tar = buildTar([
    ['repo-main/', '', '5'],
    ['repo-main/SKILL.md', '# hi\n'],
    ['repo-main/references/', '', '5'],
    ['repo-main/references/guide.md', 'guide\n'],
    [longName, 'deep\n'],
  ]);
  const entries = parseTar(tar);
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes('repo-main/SKILL.md'));
  assert.ok(names.includes('repo-main/references/guide.md'));
  assert.ok(names.includes(longName), 'GNU long-name entry parsed');
  const dirs = entries.filter((entry) => entry.type === 'dir').map((entry) => entry.name);
  assert.ok(dirs.includes('repo-main'));
  const skill = entries.find((entry) => entry.name === 'repo-main/SKILL.md');
  assert.equal(skill.data.toString('utf8'), '# hi\n');
});

test('findSkillCandidates finds root, depth-1, and skills/* layouts', () => {
  const rootRepo = [{ name: 'SKILL.md', type: 'file' }];
  assert.deepEqual(findSkillCandidates(rootRepo, ''), { ok: true, candidates: [{ name: '.root', prefix: '' }] });

  const multi = [
    { name: 'alpha/SKILL.md', type: 'file' },
    { name: 'alpha/x.md', type: 'file' },
    { name: 'beta/SKILL.md', type: 'file' },
    { name: 'not-a-skill/readme.md', type: 'file' },
  ];
  const found = findSkillCandidates(multi, '');
  assert.deepEqual(found.candidates.map((entry) => entry.name), ['alpha', 'beta']);

  const skillsDir = [{ name: 'skills/one/SKILL.md', type: 'file' }, { name: 'skills/two/SKILL.md', type: 'file' }];
  const found2 = findSkillCandidates(skillsDir, '');
  assert.deepEqual(found2.candidates.map((entry) => entry.name), ['one', 'two']);

  const subdir = findSkillCandidates(multi, 'alpha');
  assert.deepEqual(subdir.candidates, [{ name: 'alpha', prefix: 'alpha' }]);
  assert.equal(findSkillCandidates(multi, 'missing').ok, false);
  assert.equal(findSkillCandidates([{ name: 'readme.md', type: 'file' }], '').error, 'no-skill-md');
});

test('installFromGithub downloads, extracts, and copies into the skills root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-install-'));
  try {
    const tarGz = gzipSync(buildTar([
      ['my-skills-main/', '', '5'],
      ['my-skills-main/alpha/SKILL.md', '---\nname: alpha\n---\nhello'],
      ['my-skills-main/alpha/references/guide.md', 'guide'],
      ['my-skills-main/beta/SKILL.md', '---\nname: beta\n---\nhi'],
      ['my-skills-main/readme.md', 'not a skill'],
    ]));
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => tarGz };
    };
    const result = await installFromGithub({ source: 'someone/my-skills', skillsRoot: root, fetchImpl: fakeFetch });
    assert.equal(result.ok, true);
    assert.deepEqual(result.installed.map((entry) => entry.name).sort(), ['alpha', 'beta']);
    assert.equal(result.installed[0].files >= 1, true);
    assert.match(calls[0], /codeload\.github\.com\/someone\/my-skills\/tar\.gz\/refs\/heads\/main$/);

    const skill = await readFile(join(root, 'alpha', 'SKILL.md'), 'utf8');
    assert.match(skill, /name: alpha/);
    const guide = await readFile(join(root, 'alpha', 'references', 'guide.md'), 'utf8');
    assert.equal(guide, 'guide');

    // Re-running skips existing targets instead of overwriting.
    const again = await installFromGithub({ source: 'someone/my-skills', skillsRoot: root, fetchImpl: fakeFetch });
    assert.equal(again.ok, true);
    assert.deepEqual(again.installed, []);
    assert.deepEqual(again.skipped.map((entry) => entry.name).sort(), ['alpha', 'beta']);

    // Subdir form installs exactly one skill.
    const other = await mkdtemp(join(tmpdir(), 'skill-install-'));
    try {
      const single = await installFromGithub({ source: 'someone/my-skills/alpha', skillsRoot: other, fetchImpl: fakeFetch });
      assert.equal(single.ok, true);
      assert.deepEqual(single.installed.map((entry) => entry.name), ['alpha']);
      const st = await stat(join(other, 'alpha', 'SKILL.md'));
      assert.equal(st.isFile(), true);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installFromGithub surfaces download and shape failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-install-'));
  try {
    const notFound = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    const result = await installFromGithub({ source: 'someone/gone', skillsRoot: root, fetchImpl: notFound });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not-found');
    assert.equal((await installFromGithub({ source: 'what', skillsRoot: root, fetchImpl: notFound })).error, 'bad-shape');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
