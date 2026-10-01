# @doscientos/changelog

CLI sin dependencias para llevar un changelog incremental desde Git y exportarlo
a JSON para Astro, Next.js u otra aplicación. Las instrucciones para agentes
viven en la skill `product-changelog` de
[doscientos-es/skills](https://github.com/doscientos-es/skills).

## Requisitos

- Node.js 20 o posterior.
- Git y un repositorio con al menos un commit.
- El changelog y el JSON generado se versionan junto con el proyecto.

## Estándar: changelog desde Git (recomendado)

Solo Git y Conventional Commits, sin edición manual ni LLM. En cada build o
pipeline:

```bash
changelog generate src/data/changelog.json --md CHANGELOG.md
changelog generate src/data/changelog.json --md CHANGELOG.md --check   # CI
```

- `feat` → Nuevas funciones, `fix` → Correcciones, `perf` → Mejoras. El resto
  (`chore`, `refactor`, `docs`, `test`, `ci`…) no aparece.
- Una release la cierra un commit `chore(release): vX.Y.Z`. Los commits
  posteriores salen como `Sin publicar` (`version: null`), o con la versión que
  pases en `--release <versión>`.
- La fecha es la del commit. Cada cambio del JSON incluye `sha`, `type`,
  `scope` y `breaking` (`!` o `BREAKING CHANGE:`) para que el frontend los
  muestre como quiera.
- El texto de cada entrada es la descripción del commit: escríbela pensando en
  quien usa el producto. Valida mensajes con `changelog lint-commit <archivo>`
  desde un hook `commit-msg`.
- El pipeline necesita `fetch-depth: 0`; con un clon superficial falla. En
  `build` usa `--soft` para que, en plataformas que clonan con poca historia
  (Vercel), se conserven los archivos versionados en lugar de fallar.

El flujo incremental con `CHANGELOG.md` curado a mano (abajo) sigue disponible.


## Instalar

Instala el CLI compartido como dependencia de desarrollo:

```bash
pnpm add -D @doscientos/changelog
```

El CLI se ejecuta localmente desde los scripts de la app y no se descarga en
cada build.

Para usar el flujo con Augment o Codex, instala además la skill en la raíz del
proyecto:

```bash
pnpm dlx skills add doscientos-es/skills --skill product-changelog --agent augment,codex --copy --yes
```

## Primera adopción

Elige explícitamente el commit más antiguo que quieras cubrir. Ese SHA debe ser
ancestro de `HEAD`; `init` solo crea el marcador, no redacta entradas:

```bash
git rev-parse <commit-base>
pnpm exec changelog init <sha-completo>
```

Configura el destino JSON que importará tu frontend y añade scripts al
`package.json` de la aplicación. Sustituye `src/data/changelog.json` si usas otra
ruta:

```json
{
  "scripts": {
    "changelog:sync": "changelog sync src/data/changelog.json",
    "changelog:check": "changelog sync src/data/changelog.json --check"
  }
}
```

Haz que `dev` y `build` ejecuten `pnpm changelog:sync` antes de iniciar. Ejecuta
`changelog:check` en CI para detectar si el JSON versionado quedó desactualizado.
El frontend importa ese JSON; no necesita analizar Markdown en producción.

## Actualizar

1. Inspecciona el estado del repositorio y ejecuta `pnpm exec changelog plan`.
2. Revisa los commits incluidos y sus PRs si tienes acceso. Git no demuestra que
   un cambio haya llegado a producción.
3. Redacta y revisa un borrador `draft.json` con este formato:

```json
{
  "sections": [
    { "title": "Mejoras", "items": ["Descripción útil para quien usa el producto."] }
  ]
}
```

4. Añade la entrada y actualiza el artefacto:

```bash
pnpm exec changelog add <sha-de-plan> <AAAA-MM-DD> "Título" draft.json
pnpm changelog:sync
pnpm changelog:check
```

`add` solo acepta el `HEAD` actual, exige commits pendientes y usa un lock
exclusivo. Si un lock queda tras una interrupción, comprueba el proceso antes de
retirarlo. El equipo debe revisar el diff y no afirmar despliegues sin evidencia.

## Contrato y privacidad

`CHANGELOG.md` es la fuente editorial y guarda el cursor Git. El JSON solo
proyecta las entradas para la aplicación. Las categorías admitidas son `Nuevas
funciones`, `Mejoras` y `Correcciones`; usa texto plano, sin enlaces ni HTML.
No incluyas datos de clientes, información sensible, roadmap ni cambios no
aprobados para el público del changelog.

## Desarrollo y publicación

Ejecuta `pnpm run release:check` antes de publicar. La comprobación prueba el
CLI y el contenido del paquete generado. Las versiones se publican desde GitHub
Actions con `doscientos-es/actions/npm-auto-release` y npm Trusted Publishing
después de la primera publicación autorizada del paquete.
