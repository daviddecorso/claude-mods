export type BashIntent =
  | { kind: 'none' }
  | { kind: 'start'; script?: string; tool?: string }
  | { kind: 'kill'; pattern: string }

const PM_DEV = /(?:^|[\s;&|(])(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:npm|pnpm|yarn|bun)\s+(?:--filter\s+\S+\s+|-C\s+\S+\s+)?(?:run\s+)?(dev(?:[:-][\w:-]+)?)(?=[\s;&|)]|$)/
const TOOL_DEV = /(?:^|[\s;&|(]|\/)(?:npx\s+|pnpm\s+(?:exec|dlx)\s+|bunx\s+|yarn\s+)?(vite(?=\s*(?:$|[;&|)]|\s--|\s(?:dev|serve)\b))|astro\s+dev|next\s+dev|wrangler\s+dev|expo\s+start)\b/
const KILL = /\b(pkill|killall)\b([^;&|\n]*)/
const KILL_BY_PORT = /\blsof\b[^;&\n]*-t[^;&\n]*\|\s*xargs\s+kill|\bkill\b[^;&\n]*\$\(\s*lsof\b/
const DEV_PROCESS = /\b(vite|wrangler|workerd|expo|metro|astro|next|node|esbuild)\b|:\d{4}/

const NOT_A_SERVER = /\b(kill|stop|clean|reset|setup|seed|migrate)\b/

const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g

export function bashIntent(command: string): BashIntent {
  const shell = command.replace(HEREDOC, '')
  const kill = KILL.exec(shell)
  if (kill && DEV_PROCESS.test(kill[2]!)) return { kind: 'kill', pattern: kill[0].trim() }
  if (KILL_BY_PORT.test(shell)) return { kind: 'kill', pattern: 'kill by port' }

  const bare = shell.replace(QUOTED, "''")
  const pm = PM_DEV.exec(bare)
  if (pm && !NOT_A_SERVER.test(pm[1]!)) return { kind: 'start', script: pm[1] }

  const tool = TOOL_DEV.exec(bare)
  if (tool) return { kind: 'start', tool: tool[1]!.split(/\s+/)[0] }

  return { kind: 'none' }
}
