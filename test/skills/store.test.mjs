import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter,
  listSkills,
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
  resolveSkillFile,
} from '../../src/host/skills/store.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parseFrontmatter reads name and description', () => {
  const text = '---\nname: my-skill\ndescription: Does things.\n---\n\n# Body\n';
  assert.deepEqual(parseFrontmatter(text), { name: 'my-skill', description: 'Does things.' });
  const quoted = '---\nname: "quoted"\ndescription: \'single\'\n---\n';
  assert.deepEqual(parseFrontmatter(quoted), { name: 'quoted', description: 'single' });
  assert.deepEqual(parseFrontmatter('no frontmatter'), { name: null, description: null });
});

async function makeSkillsRoot() {
  const root = await mkdtemp(join(tmpdir(), 'skills-'));
  await mkdir(join(root, 'alpha'));
  await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: Alpha\ndescription: First skill.\n---\nbody', 'utf8');
  await mkdir(join(root, 'alpha', 'references'));
  await writeFile(join(root, 'alpha', 'references', 'guide.md'), 'guide', 'utf8');
  await mkdir(join(root, 'beta'));
  await writeFile(join(root, 'beta', 'SKILL.md'), '---\nname: Beta\n---\n', 'utf8');
  await mkdir(join(root, 'no-skill-md'));
  return root;
}

test('listSkills reads frontmatter and file counts, sorting by name', async () => {
  const root = await makeSkillsRoot();
  try {
    const result = await listSkills(root);
    assert.equal(result.ok, true);
    const names = result.skills.map((skill) => skill.name);
    assert.deepEqual(names, ['Alpha', 'Beta', 'no-skill-md']);
    const alpha = result.skills.find((skill) => skill.name === 'Alpha');
    assert.equal(alpha.dir, 'alpha');
    assert.equal(alpha.description, 'First skill.');
    assert.equal(alpha.hasSkillMd, true);
    assert.equal(alpha.fileCount, 2);
    const missing = result.skills.find((skill) => skill.name === 'no-skill-md');
    assert.equal(missing.hasSkillMd, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listSkillFiles skips hidden and node_modules entries', async () => {
  const root = await makeSkillsRoot();
  try {
    await mkdir(join(root, 'alpha', 'node_modules'));
    await writeFile(join(root, 'alpha', 'node_modules', 'junk.js'), 'x', 'utf8');
    const files = await listSkillFiles(join(root, 'alpha'));
    const paths = files.map((file) => file.path).sort();
    assert.deepEqual(paths, ['SKILL.md', 'references/guide.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveSkillFile rejects traversal and bad names', () => {
  const root = '/tmp/skills-root';
  assert.equal(resolveSkillFile(root, '../outside', 'SKILL.md').ok, false);
  assert.equal(resolveSkillFile(root, 'ok', '../../etc/passwd').ok, false);
  assert.equal(resolveSkillFile(root, '.hidden', 'SKILL.md').ok, false);
  const good = resolveSkillFile(root, 'ok', 'SKILL.md');
  assert.equal(good.ok, true);
  assert.equal(good.absolute, join(root, 'ok', 'SKILL.md'));
});

test('readSkillFile and writeSkillFile roundtrip with sha conflict detection', async () => {
  const root = await makeSkillsRoot();
  try {
    const read = await readSkillFile(root, 'alpha', 'SKILL.md');
    assert.equal(read.ok, true);
    assert.equal(read.file.editable, true);
    assert.match(read.file.content, /Alpha/);

    const stale = await writeSkillFile(root, 'alpha', 'SKILL.md', '---\nname: Changed\n---\nx', 'deadbeef');
    assert.equal(stale.ok, false);
    assert.equal(stale.error, 'conflict');

    const write = await writeSkillFile(root, 'alpha', 'SKILL.md', '---\nname: Changed\n---\nx', read.file.sha);
    assert.equal(write.ok, true);
    const reread = await readSkillFile(root, 'alpha', 'SKILL.md');
    assert.match(reread.file.content, /Changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readSkillFile marks binary content read-only', async () => {
  const root = await makeSkillsRoot();
  try {
    await writeFile(join(root, 'alpha', 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]), 'binary');
    const read = await readSkillFile(root, 'alpha', 'blob.bin');
    assert.equal(read.ok, true);
    assert.equal(read.file.editable, false);
    assert.equal(read.file.reason, 'binary');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readSkillFile reports a missing file', async () => {
  const root = await makeSkillsRoot();
  try {
    const read = await readSkillFile(root, 'alpha', 'nope.md');
    assert.equal(read.ok, false);
    assert.equal(read.error, 'not-found');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
