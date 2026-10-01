import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChangelog } from '../bin/changelog.mjs'

const cli = process.env.PRODUCT_CHANGELOG_CLI
  ? resolve(process.env.PRODUCT_CHANGELOG_CLI)
  : resolve(fileURLToPath(new URL('../bin/changelog.mjs', import.meta.url)))

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'product-changelog-'))
  t.after(async () => { const { rmSync } = await import('node:fs'); rmSync(cwd, { recursive: true, force: true }) })
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test')
  const commit = (message) => {
    writeFileSync(join(cwd, 'work.txt'), message)
    git('add', 'work.txt'); git('commit', '-qm', message)
    return git('rev-parse', 'HEAD')
  }
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
  return { cwd, git, commit, run }
}

test('bootstrap explícito, plan, entrada incremental, exportación e idempotencia', (t) => {
  const { cwd, commit, git, run } = fixture(t)
  const base = commit('base')
  const next = commit('feat: nueva función')
  assert.equal(run('plan').status, 1)
  assert.equal(run('init', base).status, 0)
  assert.deepEqual(JSON.parse(run('plan').stdout), {
    from: base, to: next, commits: [{ sha: next, subject: 'feat: nueva función' }],
  })
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify({ sections: [
    { title: 'Nuevas funciones', items: ['Ahora puedes consultar tus cambios.'] },
  ] }))
  writeFileSync(join(cwd, 'CHANGELOG.md.lock'), 'otro proceso')
  assert.equal(run('add', next, '2026-09-24', 'Primeras novedades', 'draft.json').status, 1)
  unlinkSync(join(cwd, 'CHANGELOG.md.lock'))
  assert.equal(run('add', next, '2026-09-24', 'Primeras novedades', 'draft.json').status, 0)
  assert.equal(existsSync(join(cwd, 'CHANGELOG.md.lock')), false)
  assert.equal(run('sync', 'changelog.json').status, 0)
  assert.equal(run('sync', 'changelog.json', '--check').status, 0)
  const before = readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8')
  assert.equal(parseChangelog(before).releases[0].sections[0].items[0], 'Ahora puedes consultar tus cambios.')
  assert.deepEqual(JSON.parse(run('plan').stdout).commits, [])
  assert.equal(run('add', next, '2026-09-24', 'Duplicado', 'draft.json').status, 1)
  assert.equal(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'), before)
  writeFileSync(join(cwd, 'changelog.json'), '{}')
  assert.equal(run('sync', 'changelog.json', '--check').status, 1)
  assert.equal(run('sync', 'changelog.json').status, 0)
  git('add', 'CHANGELOG.md', 'changelog.json'); git('commit', '-qm', 'docs: publish changelog')
  assert.equal(JSON.parse(run('plan').stdout).commits.length, 0)
  commit('feat: siguiente mejora')
  assert.equal(JSON.parse(run('plan').stdout).commits.length, 1)
})

test('rechaza historia divergente, HEAD cambiado, fechas y categorías inválidas', (t) => {
  const { cwd, commit, git, run } = fixture(t)
  const base = commit('base'); commit('otro cambio')
  assert.equal(run('init', base).status, 0)
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify({ sections: [
    { title: 'Otros', items: ['Algo'] },
  ] }))
  assert.equal(run('add', base, '2026-09-24', 'Mal', 'draft.json').status, 1)
  assert.equal(run('add', git('rev-parse', 'HEAD'), '2026-02-30', 'Mal', 'draft.json').status, 1)
  assert.equal(run('add', git('rev-parse', 'HEAD'), '2026-09-24', 'Mal', 'draft.json').status, 1)
  git('checkout', '-q', '-b', 'other', base)
  assert.equal(run('plan').status, 0) // base is still an ancestor, with no pending commits
  git('reset', '-q', '--hard', 'HEAD')
  commit('divergente')
  // The cursor is base; simulate an invalid cursor without replacing the Git history.
  const source = readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8')
  writeFileSync(join(cwd, 'CHANGELOG.md'), source.replace(base, 'a'.repeat(40)))
  assert.equal(run('plan').status, 1)
})

test('acepta Markdown con un solo salto de línea final', () => {
  const markdown = `# Novedades\n\n<!-- changelog:cursor=${'a'.repeat(40)} -->\n\n## 2026-09-24 — Novedad\n\n### Mejoras\n\n- Texto sencillo.\n`
  assert.equal(parseChangelog(markdown).releases[0].sections[0].items[0], 'Texto sencillo.')
})

test('sync genera el JSON sin necesitar metadatos Git', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'product-changelog-no-git-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const markdown = `# Novedades\n\n<!-- changelog:cursor=${'a'.repeat(40)} -->\n\n## 2026-09-24 — Novedad\n\n### Mejoras\n\n- Texto sencillo.\n`
  writeFileSync(join(cwd, 'CHANGELOG.md'), markdown)
  const result = spawnSync(process.execPath, [cli, 'sync', 'changelog.json'], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(join(cwd, 'changelog.json'), 'utf8')).releases[0].title, 'Novedad')
})
