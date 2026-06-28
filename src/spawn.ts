/**
 * spawn.ts — Tmux pane management (1:1 with Claude Code's TmuxBackend.ts)
 *
 * Full feature set:
 * - Grid layout: leader 30% left, teammates stacked on right
 * - Pane creation lock for race prevention
 * - Shell init delay (200ms)
 * - Pane border coloring and titles
 * - External swarm session support (no tmux → create claude-swarm session)
 * - Pane hide/show via break-pane / join-pane
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const TMUX_CMD = 'tmux'
const SWARM_SESSION_NAME = 'claude-swarm'
const HIDDEN_SESSION_NAME = 'claude-swarm-hidden'
const PANE_SHELL_INIT_DELAY_MS = 200

// ─── Color palette (same as Claude Code) ───────────────────────

const TMUX_COLORS: Record<string, string> = {
  red: 'red',
  blue: 'blue',
  green: 'green',
  yellow: 'yellow',
  purple: 'magenta',
  orange: 'colour208',
  pink: 'colour205',
  cyan: 'cyan',
}

function getTmuxColor(color: string): string {
  return TMUX_COLORS[color] ?? color
}

// ─── Pane creation lock (prevents race conditions) ─────────────

let paneCreationLock: Promise<void> = Promise.resolve()

async function acquirePaneCreationLock(): Promise<() => void> {
  let release: () => void
  const newLock = new Promise<void>(resolve => { release = resolve })
  const previousLock = paneCreationLock
  paneCreationLock = newLock
  await previousLock
  return release!
}

// ─── Tmux command helpers ──────────────────────────────────────

function tmux(...args: string[]): { stdout: string; code: number } {
  try {
    const result = execFileSync(TMUX_CMD, args, { encoding: 'utf-8', timeout: 10_000 })
    return { stdout: (result.stdout ?? '').trim(), code: 0 }
  } catch (err: unknown) {
    const error = err as { stderr?: string; status?: number; message?: string }
    return { stdout: error.stderr ?? error.message ?? '', code: error.status ?? 1 }
  }
}

function tmuxOrThrow(...args: string[]): string {
  const result = tmux(...args)
  if (result.code !== 0) {
    throw new Error(`tmux ${args[0] ?? ''} failed: ${result.stdout}`)
  }
  return result.stdout
}

// ─── External session management ───────────────────────────────

let externalSessionCreated = false

function ensureExternalSession(): string {
  // Check if session already exists
  const check = tmux('has-session', '-t', SWARM_SESSION_NAME)
  if (check.code === 0) return SWARM_SESSION_NAME

  // Create new session detached
  tmuxOrThrow('new-session', '-d', '-s', SWARM_SESSION_NAME, '-n', 'swarm-view')
  externalSessionCreated = true

  // Set pane border status on the swarm session
  tmux('set', '-t', SWARM_SESSION_NAME, 'pane-border-status', 'top')
  tmux('set', '-t', SWARM_SESSION_NAME, 'pane-border-format', ' #{pane_index} #{pane_title} ')

  return SWARM_SESSION_NAME
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Resolve the pi binary path for spawning teammates.
 */
export function getPiLaunchCommand(): string {
  if (process.env.PI_TEAMS_PI_BIN) return process.env.PI_TEAMS_PI_BIN

  const argv1 = process.argv[1]
  const execPath = process.execPath

  if (argv1) {
    const ext = extname(argv1).toLowerCase()
    const isScript = ['.js', '.mjs', '.cjs', '.ts'].includes(ext)
    if (isScript && existsSync(argv1)) {
      return `${execPath} ${JSON.stringify(argv1)}`
    }
  }

  const base = basename(execPath).toLowerCase()
  if (base !== 'node' && base !== 'node.exe' && base !== 'bun' && base !== 'bun.exe') {
    return execPath
  }

  return 'pi'
}

/**
 * Check if we're running inside tmux.
 */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX
}

/**
 * Create a pane for a teammate.
 * Layout strategy (matching Claude Code):
 *   - 1st teammate: split horizontally (-h), 70% right
 *   - Subsequent: split vertically (-v) within the right column for grid
 * Also supports running outside tmux by creating a claude-swarm session.
 *
 * Returns the pane ID.
 */
export async function createTeammatePane(
): Promise<string> {
  const release = await acquirePaneCreationLock()
  try {
    let paneId: string
      // Inside tmux: split current window
      const firstTeammate = teammateCount <= 1
      if (firstTeammate) {
        paneId = tmuxOrThrow(
          'split-window', '-h',
          '-l', '70%',
          '-P', '-F', '#{pane_id}',
        )
      } else {
        paneId = tmuxOrThrow(
          'split-window', '-v',
          '-P', '-F', '#{pane_id}',
        )
      }
    } else {
      // Outside tmux: try to create/use external swarm session
      try {
        const sessionName = ensureExternalSession()
        paneId = tmuxOrThrow(
          'split-window', '-h',
          '-t', `${sessionName}:swarm-view`,
          '-l', '70%',
          '-P', '-F', '#{pane_id}',
        )
      } catch {
        // tmux not available or failed — return empty paneId
        // caller will still start the worker (without visible pane)
        return ''
      }
    }
    // Style the pane
    const tmuxColor = getTmuxColor(color)
    tmux('set', '-p', '-t', paneId, 'pane-border-style', `fg=${tmuxColor}`)
    tmux('set', '-p', '-t', paneId, 'pane-active-border-style', `fg=${tmuxColor}`)
    tmux('set', '-p', '-t', paneId, 'pane-border-format',
      ` #[fg=${tmuxColor},bold]#{pane_index} ${name} `)
  } finally {
    release()
  }
}

/**
 * Send a command to a pane.
 */
export async function sendCommandToPane(paneId: string, command: string): Promise<void> {
  if (!paneId) return
  // Wait for shell initialization (same as Claude Code's PANE_SHELL_INIT_DELAY_MS)
  await sleep(PANE_SHELL_INIT_DELAY_MS)
  tmuxOrThrow('send-keys', '-t', paneId, command, 'Enter')
}

/** Set pane border color. */
export function setPaneBorderColor(paneId: string, color: string): void {
  if (!paneId) return
  const tmuxColor = getTmuxColor(color)
  tmux('set', '-p', '-t', paneId, 'pane-border-style', `fg=${tmuxColor}`)
  tmux('set', '-p', '-t', paneId, 'pane-active-border-style', `fg=${tmuxColor}`)
}

/**
 * Set pane border color.
 */
export function setPaneBorderColor(paneId: string, color: string): void {
  const tmuxColor = getTmuxColor(color)
  tmux('set', '-p', '-t', paneId, 'pane-border-style', `fg=${tmuxColor}`)
  tmux('set', '-p', '-t', paneId, 'pane-active-border-style', `fg=${tmuxColor}`)
}

/**
 * Enable pane border status globally.
 */
export function enablePaneBorderStatus(): void {
  tmux('set', '-g', 'pane-border-status', 'top')
  tmux('set', '-g', 'pane-border-format', ' #{pane_index} #{pane_title} ')
}

/**
 * Rebalance panes: leader gets 30%, teammates share 70%.
 * Uses main-vertical layout like Claude Code.
 */
export function rebalancePanes(): void {
  try {
    tmux('select-layout', 'main-vertical')
  } catch {
    // Best-effort
  }
}

/**
 * Kill (close) a pane.
 */
export function killPane(paneId: string): boolean {
  const result = tmux('kill-pane', '-t', paneId)
  return result.code === 0
}

/**
 * Hide a pane by breaking it out into a hidden window.
 */
export function hidePane(paneId: string): boolean {
  const result = tmux('break-pane', '-s', paneId, '-t', HIDDEN_SESSION_NAME)
  return result.code === 0
}

/**
 * Show a previously hidden pane by joining it back.
 */
export function showPane(paneId: string, targetWindow: string): boolean {
  const result = tmux('join-pane', '-s', paneId, '-t', targetWindow)
  return result.code === 0
}

/**
 * Wait for pane shell to be ready.
 */
export async function waitForPaneShellReady(): Promise<void> {
  await sleep(PANE_SHELL_INIT_DELAY_MS)
}
