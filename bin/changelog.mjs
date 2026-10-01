#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
const HEADER = '# Novedades\n\n'
const categories = ['Nuevas funciones', 'Mejoras', 'Correcciones']

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: process.cwd() }).trim()
}

function commit(ref) {
  const value = git('rev-parse', '--verify', `${ref}^{commit}`)
  if (!SHA.test(value)) throw new Error('Referencia Git no válida')
  return value
}

function readSource() {
  return readFileSync(resolve('CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
}

export function parseChangelog(source) {
  if (!source.startsWith(HEADER)) throw new Error('Cabecera del changelog no válida')
  const match = source.match(/^# Novedades\n\n<!-- changelog:cursor=([0-9a-f]{40}) -->\n\n/)
  if (!match) throw new Error('Falta el cursor Git del changelog')
  let rest = source.slice(match[0].length)
  const releases = []
  while (rest.length) {
    const release = rest.match(/^## (\d{4}-\d{2}-\d{2}) — ([^\n<>]+)\n\n/)
    if (!release || !validDate(release[1])) throw new Error('Entrada de changelog no válida')
    rest = rest.slice(release[0].length)
    const sections = []
    while (rest.startsWith('### ')) {
      const section = rest.match(/^### ([^\n]+)\n\n/)
      if (!section || !categories.includes(section[1])) throw new Error('Categoría no válida')
      rest = rest.slice(section[0].length)
      const items = []
      while (rest.startsWith('- ')) {
        const item = rest.match(/^- ([^\n<>]+)\n/)
        if (!item || !item[1].trim() || /\[[^\]]+\]\(/.test(item[1])) {
          throw new Error('Usa texto plano en las novedades')
        }
        items.push(item[1])
        rest = rest.slice(item[0].length)
      }
      if (!items.length || (rest && !rest.startsWith('\n'))) throw new Error('Categoría vacía o mal formada')
      if (rest) rest = rest.slice(1)
      if (sections.some((s) => s.title === section[1])) throw new Error('Categoría repetida')
      sections.push({ title: section[1], items })
    }
    if (!sections.length) throw new Error('Entrada sin novedades')
    releases.push({ date: release[1], title: release[2], sections })
  }
  return { cursor: match[1], releases }
}

function validDate(date) {
  const d = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === date
}

function pending(cursor, head) {
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', cursor, head], { cwd: process.cwd() })
  if (ancestor.status !== 0) throw new Error('El cursor no es ancestro de HEAD; revisa la historia Git')
  return cursor === head ? [] : git('log', '--format=%H%x09%s', `${cursor}..${head}`)
    .split('\n').map((line) => {
      const [sha, ...subject] = line.split('\t')
      return { sha, subject: subject.join('\t') }
    }).filter(({ sha }) => git('diff-tree', '--no-commit-id', '--name-only', '-r', sha)
      .split('\n').some((file) => file !== 'CHANGELOG.md' && !/(^|\/)changelog\.json$/.test(file)))
}

function save(path, content) {
  const target = resolve(path)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, content, { flag: 'wx' })
  renameSync(temp, target)
}

export function renderRelease(date, title, sections) {
  if (!validDate(date) || !title?.trim() || /[\n<>]/.test(title)) throw new Error('Fecha o título no válidos')
  if (!sections.length || sections.some((s) => !categories.includes(s.title) || !s.items.length)) {
    throw new Error('Se necesita al menos una categoría con novedades')
  }
  return `## ${date} — ${title.trim()}\n\n${sections.map((s) =>
    `### ${s.title}\n\n${s.items.map((item) => `- ${item}`).join('\n')}\n\n`).join('')}`
}

// Conventional Commits: feat/fix/perf are user-facing; the rest never reach the changelog.
const TYPE_CATEGORY = { feat: 'Nuevas funciones', fix: 'Correcciones', perf: 'Mejoras' }
const COMMIT_TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'style', 'test', 'build', 'ci', 'chore', 'revert']
const CONVENTIONAL = /^([a-z]+)(?:\(([^()\n]+)\))?(!)?: (\S.*)$/
const RELEASE = /^chore\(release\): v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)(?: \[skip ci\])?$/

export function parseCommit(subject, body = '') {
  const match = subject.match(CONVENTIONAL)
  if (!match || !COMMIT_TYPES.includes(match[1])) return null
  return {
    type: match[1],
    scope: match[2] ?? null,
    breaking: Boolean(match[3]) || /^BREAKING[ -]CHANGE:/m.test(body),
    description: match[4].trim(),
  }
}

export function lintCommitMessage(message) {
  const header = message.replace(/\r\n/g, '\n').split('\n').find((line) => line.trim() && !line.startsWith('#')) ?? ''
  if (/^(Merge |Revert "|fixup! |squash! )/.test(header)) return
  if (header.length > 100 || !parseCommit(header)) {
    throw new Error(`Mensaje de commit no válido: "${header}"\nUsa Conventional Commits: <tipo>(<ámbito opcional>)!: <descripción>\nTipos: ${COMMIT_TYPES.join(', ')}`)
  }
}

export function buildReleases(commits, { release, date } = {}) {
  // commits: oldest first. A `chore(release): vX` commit closes the previous release.
  const releases = []
  let bucket = []
  const close = (version, day) => {
    const changes = bucket.reverse().filter((c) => TYPE_CATEGORY[c.type]).map(({ sha, type, scope, breaking, description }) =>
      ({ sha, type, scope, breaking, description: description[0].toUpperCase() + description.slice(1) }))
    bucket = []
    if (!changes.length) return
    const sections = categories.map((title) => ({
      title,
      items: changes.filter((c) => TYPE_CATEGORY[c.type] === title).map((c) => c.description),
    })).filter((s) => s.items.length)
    releases.unshift({ version, date: day, title: `v${version}`, sections, changes })
  }
  for (const c of commits) {
    const boundary = c.subject.match(RELEASE)
    if (boundary) close(boundary[1], c.date)
    else {
      const parsed = parseCommit(c.subject, c.body)
      if (parsed) bucket.push({ sha: c.sha, ...parsed })
    }
  }
  if (release && bucket.length) close(release, date ?? commits.at(-1).date)
  return releases
}

function readHistory(since) {
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    throw new Error('Historia Git superficial; usa fetch-depth: 0 para generar el changelog')
  }
  const range = since ? [`${commit(since)}..HEAD`] : ['HEAD']
  const raw = execFileSync('git', ['log', '--reverse', '--format=%H%x1f%cI%x1f%s%x1f%b%x1e', ...range],
    { encoding: 'utf8', cwd: process.cwd() })
  return raw.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim()).map((record) => {
    const [sha, iso, subject, body = ''] = record.split('\x1f')
    return { sha, date: iso.slice(0, 10), subject, body }
  })
}

function generate(args) {
  const [out, ...flags] = args
  const option = (name) => { const i = flags.indexOf(name); return i === -1 ? undefined : flags[i + 1] }
  const check = flags.includes('--check')
  if (!out || flags.some((f) => f.startsWith('--') && !['--check', '--since', '--release', '--md'].includes(f))) {
    throw new Error('Uso: generate <ruta.json> [--md <CHANGELOG.md>] [--since <sha>] [--release <versión>] [--check]')
  }
  const version = option('--release')
  if (version !== undefined && !/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(version)) throw new Error('Versión no válida')
  const releases = buildReleases(readHistory(option('--since')), { release: version })
  const outputs = [[out, `${JSON.stringify({ releases }, null, 2)}\n`]]
  if (option('--md')) {
    const body = releases.map((r) => renderRelease(r.date, r.title, r.sections)).join('')
    outputs.push([option('--md'), `${HEADER}<!-- generado desde Git con Conventional Commits; no editar a mano -->\n\n${body}`])
  }
  for (const [path, content] of outputs) {
    const same = existsSync(path) && readFileSync(path, 'utf8').replace(/\r\n/g, '\n') === content
    if (check) { if (!same) throw new Error(`${path} desactualizado; ejecuta generate`) }
    else if (!same) save(path, content)
  }
}

function run([command, ...args]) {
  if (command === 'generate') return generate(args)
  if (command === 'lint-commit') {
    if (!args[0]) throw new Error('Uso: lint-commit <archivo-mensaje>')
    return lintCommitMessage(readFileSync(resolve(args[0]), 'utf8'))
  }
  // JSON projection only reads CHANGELOG.md; it must also work where builds
  // receive source files without Git history.
  const head = command === 'sync' ? null : commit('HEAD')
  if (command === 'init') {
    if (existsSync('CHANGELOG.md')) throw new Error('CHANGELOG.md ya existe')
    if (!args[0] || !SHA.test(args[0])) throw new Error('Indica el SHA completo inicial')
    const base = commit(args[0])
    pending(base, head)
    save('CHANGELOG.md', `${HEADER}<!-- changelog:cursor=${base} -->\n\n`)
    return
  }
  const source = readSource()
  const { cursor, releases } = parseChangelog(source)
  if (command === 'plan') {
    console.log(JSON.stringify({ from: cursor, to: head, commits: pending(cursor, head) }, null, 2))
    return
  }
  if (command === 'add') {
    const lock = openSync('CHANGELOG.md.lock', 'wx')
    try {
      if (readSource() !== source) throw new Error('El changelog cambió mientras se preparaba la entrada')
      const [to, date, title, draftPath] = args
      if (!SHA.test(to ?? '') || to !== head) throw new Error('HEAD ha cambiado; vuelve a ejecutar plan')
      if (!draftPath || !pending(cursor, head).length) throw new Error('No hay commits pendientes o falta el borrador')
      const sections = JSON.parse(readFileSync(resolve(draftPath), 'utf8')).sections
      const entry = renderRelease(date, title, sections)
      parseChangelog(`${HEADER}<!-- changelog:cursor=${to} -->\n\n${entry}`)
      const start = source.match(/^# Novedades\n\n<!-- changelog:cursor=[0-9a-f]{40} -->\n\n/)[0]
      save('CHANGELOG.md', `${HEADER}<!-- changelog:cursor=${to} -->\n\n${entry}${source.slice(start.length)}`)
      console.log(`Añadida entrada; ${releases.length + 1} entradas en total. Ejecuta sync.`)
      return
    } finally {
      closeSync(lock)
      unlinkSync('CHANGELOG.md.lock')
    }
  }
  if (command === 'sync') {
    const [out, check] = args
    if (!out || (check && check !== '--check')) throw new Error('Uso: sync <ruta.json> [--check]')
    const json = `${JSON.stringify({ releases }, null, 2)}\n`
    if (check) {
      if (!existsSync(out) || readFileSync(out, 'utf8') !== json) throw new Error('JSON desactualizado; ejecuta sync')
    } else if (!existsSync(out) || readFileSync(out, 'utf8') !== json) save(out, json)
    return
  }
  throw new Error('Uso: generate <ruta.json> [--md <CHANGELOG.md>] [--since <sha>] [--release <versión>] [--check] | lint-commit <archivo> | init <sha> | plan | add <sha> <AAAA-MM-DD> <título> <borrador.json> | sync <ruta.json> [--check]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
