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

function run([command, ...args]) {
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
  throw new Error('Uso: init <sha> | plan | add <sha> <AAAA-MM-DD> <título> <borrador.json> | sync <ruta.json> [--check]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
