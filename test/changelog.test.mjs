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


test('generate agrupa Conventional Commits por release, filtra ruido y es idempotente', (t) => {
  const { cwd, commit, run } = fixture(t)
  commit('chore: base')
  commit('feat(leads): preparar preguntas de descubrimiento')
  commit('fix: corregir envío de correo')
  commit('chore(release): v0.1.1 [skip ci]')
  commit('refactor: limpiar módulo')
  commit('perf!: acelerar listado')
  commit('Fix legacy bug')
  commit('Add legacy thing')
  commit('chore(release): v0.1.2 [skip ci]')
  commit('feat: pendiente sin release')
  assert.equal(run('generate', 'out.json').status, 0)
  const { releases } = JSON.parse(readFileSync(join(cwd, 'out.json'), 'utf8'))
  assert.deepEqual(releases.map((r) => r.version), [null, '0.1.2', '0.1.1'])
  assert.equal(releases[0].title, 'Sin publicar')
  releases.shift()
  assert.deepEqual(releases[1].sections, [
    { title: 'Nuevas funciones', items: ['Preparar preguntas de descubrimiento'] },
    { title: 'Correcciones', items: ['Corregir envío de correo'] },
  ])
  assert.equal(releases[1].changes.find((c) => c.type === 'feat').scope, 'leads')
  assert.deepEqual(releases[0].changes.map((c) => [c.type, c.description]),
    [['feat', 'Add legacy thing'], ['fix', 'Fix legacy bug'], ['perf', 'Acelerar listado']])
  assert.equal(releases[0].changes[2].breaking, true)
  assert.match(releases[1].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(run('generate', 'out.json', '--check').status, 0)
  assert.equal(run('generate', 'out.json', '--release', '0.1.3').status, 0)
  assert.equal(JSON.parse(readFileSync(join(cwd, 'out.json'), 'utf8')).releases[0].version, '0.1.3')
  assert.equal(run('generate', 'out.json', '--check').status, 1)
  assert.equal(run('generate', 'out.json', '--release', 'x').status, 1)
  assert.equal(run('generate', 'out.json', '--md', 'CHANGELOG.md').status, 0)
  const md = readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8')
  assert.match(md, /^# Novedades\n\n/)
  assert.match(md, /## \d{4}-\d{2}-\d{2} — v0\.1\.2\n\n### Mejoras\n\n- Acelerar listado/)
  assert.match(md, /— Sin publicar\n\n### Nuevas funciones\n\n- Pendiente sin release/)
  assert.equal(run('generate', 'out.json', '--md', 'CHANGELOG.md', '--check').status, 0)
})

test('generate falla en clon superficial salvo con --soft', (t) => {
  const { cwd, commit } = fixture(t)
  commit('feat: uno'); commit('feat: dos')
  const shallow = mkdtempSync(join(tmpdir(), 'product-changelog-shallow-'))
  t.after(() => rmSync(shallow, { recursive: true, force: true }))
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${cwd.replace(/\\/g, '/')}`, shallow])
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: shallow, encoding: 'utf8' })
  assert.equal(run('generate', 'out.json').status, 1)
  assert.equal(run('generate', 'out.json', '--soft').status, 0)
  assert.equal(existsSync(join(shallow, 'out.json')), false)
})


test('lint-commit acepta Conventional Commits y rechaza el resto', (t) => {
  const { cwd, run } = fixture(t)
  const lint = (message) => {
    writeFileSync(join(cwd, 'MSG'), message)
    return run('lint-commit', 'MSG').status
  }
  assert.equal(lint('feat(ui)!: nuevo botón\n\nBREAKING CHANGE: x'), 0)
  assert.equal(lint('# comentario\nfix: arreglo'), 0)
  assert.equal(lint('Merge branch main'), 0)
  assert.equal(lint('Add stuff'), 1)
  assert.equal(lint('feature: algo'), 1)
  assert.equal(lint('feat:sin espacio'), 1)
})
