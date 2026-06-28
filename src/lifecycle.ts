/**
 * lifecycle.ts — Teammate shutdown handshake protocol.
 *
 * Claude Code-equivalent of the shutdown flow in inProcessRunner.ts.
 * The leader sends a shutdown_request via mailbox; the worker can
 * approve or reject. If approved, the leader sends SIGTERM (then SIGKILL).
 * If rejected, the leader respects the decision (but can retry).
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { TeamConfig } from './team-config.js'
import { setMemberStatus, removeMember } from './team-config.js'
import { writeToMailbox, popUnreadMessages } from './mailbox.js'
import { TEAM_MAILBOX_NS, SHUTDOWN_GRACE_MS, SHUTDOWN_HANDSHAKE_TIMEOUT_MS } from './protocol.js'
import type { ShutdownRequest, ShutdownApproved, ShutdownRejected } from './protocol.js'
import { isShutdownApproved, isShutdownRejected } from './protocol.js'
import { sanitizeName } from './names.js'

type ShutdownResult =
  | { type: 'approved'; requestId: string }
  | { type: 'rejected'; reason?: string }
  | { type: 'timeout' }
  | { type: 'error'; message: string }

/**
 * Request graceful shutdown of a teammate and wait for response.
 *
 * Claude Code:
 *   - leader writes shutdown_request to worker's mailbox
 *   - worker reads it, calls approveShutdown / rejectShutdown tool
 *   - leader polls mailbox for response
 *   - approved → SIGTERM, rejected → respect decision
 */
export async function requestTeammateShutdown(
  teamDir: string,
  agentName: string,
  options?: { reason?: string; paneId?: string },
): Promise<ShutdownResult> {
  const requestId = randomUUID()
  const ts = new Date().toISOString()

  // Send shutdown request via mailbox
  const shutdownMsg: ShutdownRequest = {
    type: 'shutdown_request',
    requestId,
    from: 'team-lead',
    reason: options?.reason,
    timestamp: ts,
  }

  await writeToMailbox(teamDir, TEAM_MAILBOX_NS, agentName, {
    from: 'team-lead',
    text: JSON.stringify(shutdownMsg),
    timestamp: ts,
  })

  // Wait for response with timeout
  const deadline = Date.now() + SHUTDOWN_HANDSHAKE_TIMEOUT_MS
  while (Date.now() < deadline) {
    // Poll leader's inbox for response
    const leadMessages = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, 'team-lead')

    for (const msg of leadMessages) {
      const parsed = tryParseMessage(msg.text)

      if (isShutdownApproved(parsed) && parsed.requestId === requestId) {
        return { type: 'approved', requestId }
      }

      if (isShutdownRejected(parsed) && parsed.requestId === requestId) {
        return { type: 'rejected', reason: parsed.reason }
      }
    }

    // Sleep 200ms before polling again
    await sleep(200)
  }

  return { type: 'timeout' }
}

function tryParseMessage(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Execute the actual process termination after approval.
 * Sends SIGTERM, then SIGKILL after grace period.
 */
export function terminateTmuxProcess(paneId?: string): void {
  if (!paneId) return

  // SIGTERM: graceful
  try {
    spawnSync('tmux', ['send-keys', '-t', paneId, 'C-c'], { timeout: 2000 })
  } catch {
    // Ignore
  }

  // SIGKILL after grace period
  setTimeout(() => {
    try {
      spawnSync('tmux', ['kill-pane', '-t', paneId], { timeout: 2000 })
    } catch {
      // Ignore
    }
  }, SHUTDOWN_GRACE_MS)
}

/**
 * Clean shutdown of a teammate: handshake → terminate → update config.
 */
export async function shutdownTeammate(
  teamDir: string,
  teamId: string,
  agentName: string,
  options?: { reason?: string; paneId?: string },
): Promise<boolean> {
  // 1. Handshake
  const result = await requestTeammateShutdown(teamDir, agentName, options)

  // 2. Terminate process
  if (result.type === 'approved' || result.type === 'timeout') {
    terminateTmuxProcess(options?.paneId)
  }

  // 3. Update team config
  await setMemberStatus(teamId, sanitizeName(agentName), 'offline', {
    meta: {
      shutdownResult: result.type,
      shutdownReason: options?.reason,
      shutdownAt: new Date().toISOString(),
    },
  })

  if (result.type === 'approved' || result.type === 'timeout') {
    await removeMember(teamId, sanitizeName(agentName))
  }

  return result.type === 'approved'
}
