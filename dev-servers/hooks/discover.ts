export type Kind = 'vite' | 'astro' | 'next' | 'wrangler' | 'expo' | 'other'

export type Service = {
  name: string
  dir: string
  // The package script behind it, for the package-manager fallback; absent for a bare `wrangler dev`.
  script?: string
  argv: string[]
  env: Record<string, string>
  kind: Kind
}

export type PackageInfo = {
  // Relative to the repo root; '' for the root package.
  dir: string
  scripts: Record<string, string>
  hasWrangler: boolean
}

export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun'

const PORT_RANGES: Record<Kind, [number, number] | undefined> = {
  vite: [5180, 5299],
  astro: [5180, 5299],
  next: [5180, 5299],
  wrangler: [8790, 8899],
  expo: [8181, 8199],
  other: undefined,
}

const DEV_SCRIPT = /^dev([:-][\w:-]+)?$/
const NOT_A_SERVER = /\b(kill|stop|clean|reset|setup|seed|migrate)\b/

const SHELL_SYNTAX = /[;&|<>`$()]|\b(cd|export)\s/

function kindOf(words: string[]): Kind {
  const bin = words[0]
  if (bin === 'vite' && (words.length === 1 || ['dev', 'serve', '--config', '-c', '--host', '--mode'].includes(words[1]!))) return 'vite'
  if (bin === 'astro' && words[1] === 'dev') return 'astro'
  if (bin === 'next' && words[1] === 'dev') return 'next'
  if (bin === 'wrangler' && words[1] === 'dev') return 'wrangler'
  if (bin === 'expo' && words[1] === 'start') return 'expo'
  return 'other'
}

function serviceName(dir: string, script: string): string {
  return dir === '' ? script : `${dir}:${script}`
}

// How one script runs: its own binary when the script is a plain command, so the mod owns the server's pid; otherwise through the package manager.
export function planScript(
  dir: string,
  script: string,
  body: string,
  pm: PackageManager,
): Service {
  const env: Record<string, string> = {}
  const words = body.trim().split(/\s+/)
  while (words.length > 0 && /^[A-Z_][A-Z0-9_]*=\S*$/.test(words[0]!)) {
    const [key, ...rest] = words.shift()!.split('=')
    env[key!] = rest.join('=')
  }

  const name = serviceName(dir, script)
  if (SHELL_SYNTAX.test(words.join(' ')) || words.length === 0) {
    return { name, dir, script, argv: [pm, 'run', script], env: {}, kind: 'other' }
  }

  const kind = kindOf(words)
  if (kind === 'expo') env.CI = '1'
  return { name, dir, script, argv: words, env, kind }
}

export function discover(packages: PackageInfo[], pm: PackageManager): Service[] {
  const services: Service[] = []

  for (const pkg of packages) {
    let hasWranglerScript = false
    for (const [script, body] of Object.entries(pkg.scripts)) {
      if (!DEV_SCRIPT.test(script) || NOT_A_SERVER.test(script) || NOT_A_SERVER.test(body)) continue
      if (/\bwrangler\s+dev\b/.test(body)) hasWranglerScript = true
      services.push(planScript(pkg.dir, script, body, pm))
    }
    if (pkg.hasWrangler && !hasWranglerScript) {
      services.push({ name: serviceName(pkg.dir, 'wrangler'), dir: pkg.dir, argv: ['wrangler', 'dev'], env: {}, kind: 'wrangler' })
    }
  }

  return services
}

export function portRange(kind: Kind): [number, number] | undefined {
  return PORT_RANGES[kind]
}

export function portArgs(kind: Kind, port: number): string[] {
  const p = String(port)
  if (kind === 'vite') return ['--port', p, '--strictPort']
  if (kind === 'next') return ['-p', p]
  if (kind === 'astro' || kind === 'wrangler' || kind === 'expo') return ['--port', p]
  return []
}

export function allocatePort(kind: Kind, taken: ReadonlySet<number>): number | undefined {
  const range = PORT_RANGES[kind]
  if (!range) return undefined
  for (let port = range[0]; port <= range[1]; port++) {
    if (!taken.has(port)) return port
  }

  return undefined
}

export function detectPackageManager(lockfiles: ReadonlySet<string>): PackageManager {
  if (lockfiles.has('pnpm-lock.yaml')) return 'pnpm'
  if (lockfiles.has('bun.lockb') || lockfiles.has('bun.lock')) return 'bun'
  if (lockfiles.has('yarn.lock')) return 'yarn'
  return 'npm'
}

// Workspace globs as pnpm-workspace.yaml and package.json write them; only `dir/*` and plain dirs are expanded.
export function workspaceGlobs(rootPackageJson: unknown, pnpmWorkspaceYaml: string | undefined): string[] {
  const globs: string[] = []
  if (pnpmWorkspaceYaml) {
    for (const match of pnpmWorkspaceYaml.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)) globs.push(match[1]!)
  }
  const workspaces = (rootPackageJson as { workspaces?: unknown } | undefined)?.workspaces
  const list = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages
  if (Array.isArray(list)) globs.push(...list.filter((g): g is string => typeof g === 'string'))

  return globs.filter(g => !g.startsWith('!'))
}
