/**
 * worker.ts — Teammate worker logic (1:1 with Claude Code's inProcessRunner.ts worker portion)
 *
 * Full feature set:
 * - Mailbox polling (350ms + jitter)
 * - Auto-claim tasks on idle
 * - Plan approval workflow (request → wait → proceed on approval)
 * - Permission request routing (ask leader → wait → apply decision)
 * - Shutdown handshake (approve/reject)
 * - Peer-to-peer DM with summary tracking
 * - agent_start/agent_end lifecycle hooks
 * - SIGTERM cleanup
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { randomUUID } from 'node:crypto'
import { popUnreadMessages, writeToMailbox, readMailbox } from './mailbox.js'
import { claimNextAvailableTask, completeTask, updateTask, getTask } from './task-store.js'
import { ensureTeamConfig, upsertMember, setMemberStatus } from './team-config.js'
import { sanitizeName } from './names.js'
import { getTeamDir } from './paths.js'
import {
  TEAM_MAILBOX_NS,
  isShutdownRequest, isPlanApproved, isPlanRejected, isPermissionResponse,
  isModeSetRequest, isSetSessionName,
} from './protocol.js'
import { isTeammate, getAgentName, getTeamName, isPlanModeRequired, getTeammateColor } from './identity.js'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Worker Environment ────────────────────────────────────────

type WorkerEnv = {
  teamId: string
  teamDir: string
  taskListId: string
  agentName: string
  leadName: string
  autoClaim: boolean
}

function getWorkerEnv(): WorkerEnv | null {
  const teamId = process.env.PI_TEAMS_TEAM_ID
  const agentName = process.env.PI_TEAMS_AGENT_NAME
  if (!teamId || !agentName) return null

  return {
    teamId,
    teamDir: getTeamDir(teamId),
    taskListId: process.env.PI_TEAMS_TASK_LIST_ID ?? teamId,
    agentName: sanitizeName(agentName),
    leadName: sanitizeName(process.env.PI_TEAMS_LEAD_NAME ?? 'team-lead'),
    autoClaim: (process.env.PI_TEAMS_AUTO_CLAIM ?? '1') === '1',
  }
}

// ─── Entry Point ───────────────────────────────────────────────

export function runWorker(pi: ExtensionAPI): void {
  const env = getWorkerEnv()
  if (!env) return

  const { teamId, teamDir, taskListId, agentName, leadName, autoClaim } = env

  // ─── State ────────────────────────────────────────────

  let ctxRef: ExtensionContext | null = null
  let isStreaming = false
  let isDeciding = false
  let currentTaskId: string | null = null
  let pollAbort = false
  let shutdownInProgress = false
  let planMode = isPlanModeRequired()
  let planApproved = false
  let planRequestId: string | null = null
  let lastPeerDmSummary: string | null = null
  const seenShutdownIds = new Set<string>()

  // ─── Tool: team_message (peer-to-peer) ────────────────

  pi.registerTool({
    name: 'team_message',
    label: 'Team Message',
    description: 'Send a coordination message to another teammate. Use urgent=true to interrupt their active turn.',
    parameters: Type.Object({
      recipient: Type.String({ description: 'Name of the teammate to message' }),
      message: Type.String({ description: 'Message content' }),
      urgent: Type.Optional(Type.Boolean({ description: 'Interrupt the recipient\'s active turn' })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const ts = new Date().toISOString()
      // Track DM summary for idle notification
      lastPeerDmSummary = params.message.slice(0, 100)

      await writeToMailbox(teamDir, params.recipient, {
        from: agentName,
        text: params.message,
        timestamp: ts,
        ...(params.urgent ? { urgent: true } : {}),
      })
      // CC leader with notification
      await writeToMailbox(teamDir, leadName, {
        from: agentName,
        text: JSON.stringify({
          type: 'peer_dm_sent',
          from: agentName,
          to: params.recipient,
          summary: params.message.slice(0, 100),
          urgent: params.urgent,
          timestamp: ts,
        }),
        timestamp: ts,
      })
      return { content: [{ type: 'text', text: `Message sent to ${params.recipient}.` }] }
    },
  })

  // ─── Tool: submit_plan (for plan approval workflow) ───

  pi.registerTool({
    name: 'submit_plan',
    label: 'Submit Plan',
    description: 'Submit your implementation plan for leader approval. Only available when plan mode is active. Call this at the end of your planning turn.',
    parameters: Type.Object({
      plan: Type.String({ description: 'Your implementation plan' }),
      task_id: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const reqId = randomUUID()
      planRequestId = reqId
      const ts = new Date().toISOString()

      await writeToMailbox(teamDir, leadName, {
        from: agentName,
        text: JSON.stringify({
          type: 'plan_approval_request',
          requestId: reqId,
          from: agentName,
          plan: params.plan,
          taskId: params.task_id ?? currentTaskId ?? undefined,
          timestamp: ts,
        }),
        timestamp: ts,
      })

      return {
        content: [{ type: 'text', text: `Plan submitted for review. Waiting for leader approval${params.task_id ? ` (task #${params.task_id})` : ''}...` }],
      }
    },
  })

  // ─── Tool: request_permission (for permission routing) ─

  pi.registerTool({
    name: 'request_permission',
    label: 'Request Permission',
    description: 'Request permission from the team lead to use a tool with specific arguments.',
    parameters: Type.Object({
      tool_name: Type.String(),
      arguments: Type.String({ description: 'Tool arguments as JSON string' }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const reqId = randomUUID()
      const ts = new Date().toISOString()

      await writeToMailbox(teamDir, leadName, {
        from: agentName,
        text: JSON.stringify({
          type: 'permission_request',
          requestId: reqId,
          from: agentName,
          toolName: params.tool_name,
          args: params.arguments,
          timestamp: ts,
        }),
        timestamp: ts,
      })

      // Wait for response by polling our own inbox
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const msgs = await popUnreadMessages(teamDir, agentName)
        for (const msg of msgs) {
          const parsed = tryParseJson(msg.text)
          if (parsed && isPermissionResponse(parsed) && parsed.requestId === reqId) {
            if (parsed.approved) {
              return { content: [{ type: 'text', text: `Permission approved for ${params.tool_name}.` }] }
            }
            return { content: [{ type: 'text', text: `Permission denied for ${params.tool_name}. Reason: ${parsed.reason ?? 'No reason given.'}` }] }
          }
        }
        await sleep(200)
      }

      return { content: [{ type: 'text', text: `Permission request for ${params.tool_name} timed out.` }] }
    },
  })

  // ─── Poll loop ────────────────────────────────────────

  const poll = async () => {
    while (!pollAbort) {
      try {
        const unread = await popUnreadMessages(teamDir, agentName)

        for (const msg of unread) {
          const parsed = tryParseJson(msg.text)

          // ── Shutdown request (highest priority) ──────
          if (parsed && isShutdownRequest(parsed) && !seenShutdownIds.has(parsed.requestId)) {
            seenShutdownIds.add(parsed.requestId)
            const ts = new Date().toISOString()

            if (currentTaskId) {
              await writeToMailbox(teamDir, leadName, {
                from: agentName,
                text: JSON.stringify({
                  type: 'shutdown_rejected',
                  requestId: parsed.requestId,
                  from: agentName,
                  reason: `Working on task #${currentTaskId}`,
                  timestamp: ts,
                }),
                timestamp: ts,
              })
            } else {
              shutdownInProgress = true
              pollAbort = true
              await writeToMailbox(teamDir, leadName, {
                from: agentName,
                text: JSON.stringify({
                  type: 'shutdown_approved',
                  requestId: parsed.requestId,
                  from: agentName,
                  timestamp: ts,
                }),
                timestamp: ts,
              })
              try { await setMemberStatus(teamId, agentName, 'offline', { meta: { offlineReason: 'shutdown' } }) } catch { /* ignore */ }
              try { ctxRef?.shutdown() } catch { /* ignore */ }
              return
            }
            continue
          }

          // ── Plan approval/rejection ─────────────────
          if (parsed && isPlanApproved(parsed) && planRequestId && parsed.requestId === planRequestId) {
            planApproved = true
            planMode = false
            planRequestId = null
            pi.sendUserMessage('Your plan has been approved. Proceed with implementation.')
            continue
          }
          if (parsed && isPlanRejected(parsed) && planRequestId && parsed.requestId === planRequestId) {
            planRequestId = null
            pi.sendUserMessage(`Your plan was rejected. Feedback: ${parsed.feedback ?? 'Revise and resubmit.'}`)
            continue
          }

          // ── Set session name from leader ──────────
          if (parsed && isSetSessionName(parsed)) {
            try {
              const existing = pi.getSessionName?.()
              if (!existing || existing.startsWith('pi agent teams -')) {
                pi.setSessionName(parsed.name)
              }
            } catch { /* ignore */ }
            continue
          }

          // ── Urgent DM (interrupt active turn) ────
          if (msg.urgent && isStreaming && ctxRef) {
            pi.sendUserMessage(`[URGENT from ${msg.from}] ${msg.text}`, { deliverAs: 'steer' })
            continue
          }

          // ── Non-urgent DM (queue for idle) ──────
          if (!isStreaming) {
            pi.sendUserMessage(`Message from ${msg.from}: ${msg.text}`)
          }
        }

        if (!shutdownInProgress) await maybeStartNextWork()
      } catch { /* ignore */ }

      await sleep(350 + Math.floor(Math.random() * 200))
    }
  }

  // ─── Auto-claim ──────────────────────────────────────

  const maybeStartNextWork = async () => {
    if (!ctxRef || shutdownInProgress || isStreaming || currentTaskId || isDeciding) return

    isDeciding = true
    try {
      if (autoClaim) {
        await sleep(Math.floor(Math.random() * 250))
        const claimed = await claimNextAvailableTask(taskListId, agentName)
        if (claimed) {
          currentTaskId = claimed.id
          isStreaming = true
          const prompt = buildTaskPrompt(agentName, claimed, planMode && !planApproved)
          pi.sendUserMessage(prompt)
          return
        }
      }
    } finally {
      isDeciding = false
    }
  }

  // ─── Idle notification ──────────────────────────────

  const sendIdleNotification = async (
    completedTaskId?: string,
    completedStatus?: 'completed' | 'failed',
  ) => {
    const ts = new Date().toISOString()
    await writeToMailbox(teamDir, leadName, {
      from: agentName,
      text: JSON.stringify({
        type: 'idle_notification',
        from: agentName,
        timestamp: ts,
        completedTaskId,
        completedStatus,
      }),
      timestamp: ts,
    })
  }

  // ─── Event Handlers ─────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    ctxRef = ctx

    try {
      await ensureTeamConfig(teamId, { leadName, taskListId })
      await upsertMember(teamId, {
        name: agentName,
        role: 'worker',
        status: 'online',
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        joinedAt: Date.now(),
        lastSeenAt: new Date().toISOString(),
      })
    } catch { /* ignore */ }

    void poll()

    await sleep(500)
    if (!isStreaming && !currentTaskId) {
      await sendIdleNotification()
    }
  })

  pi.on('session_shutdown', async () => {
    pollAbort = true
    try { await setMemberStatus(teamId, agentName, 'offline', { meta: { offlineReason: 'shutdown' } }) } catch { /* ignore */ }
    await sendIdleNotification()
  })

  pi.on('agent_start', () => {
    isStreaming = true
  })

  pi.on('agent_end', async (event) => {
    isStreaming = false

    // Plan mode: if plan not yet approved, submit for approval
    if (planMode && !planApproved && currentTaskId && !planRequestId) {
      const lastText = extractLastAssistantText(event)
      const reqId = randomUUID()
      planRequestId = reqId
      const ts = new Date().toISOString()

      await writeToMailbox(teamDir, leadName, {
        from: agentName,
        text: JSON.stringify({
          type: 'plan_approval_request',
          requestId: reqId,
          from: agentName,
          plan: lastText,
          taskId: currentTaskId,
          timestamp: ts,
        }),
        timestamp: ts,
      })
      // Don't clear currentTaskId — wait for approval
      return
    }

    const taskId = currentTaskId
    currentTaskId = null

    let completedTaskId: string | undefined
    let completedStatus: 'completed' | 'failed' | undefined

    if (taskId) {
      const result = extractLastAssistantText(event)
      if (result.trim().length > 0) {
        await completeTask(taskListId, taskId, agentName, result)
        completedTaskId = taskId
        completedStatus = 'completed'
      } else {
        await updateTask(taskListId, taskId, t => ({
          ...t,
          status: 'pending',
          metadata: { ...t.metadata, abortedAt: new Date().toISOString() },
        }))
        completedTaskId = taskId
        completedStatus = 'failed'
      }
    }

    await maybeStartNextWork()

    if (!isStreaming && !currentTaskId) {
      await sendIdleNotification(completedTaskId, completedStatus)
    }
  })

  process.on('SIGTERM', () => {
    pollAbort = true
    void (async () => {
      try { await setMemberStatus(teamId, agentName, 'offline', { meta: { offlineReason: 'SIGTERM' } }) } catch { /* ignore */ }
      await sendIdleNotification()
    })().finally(() => process.exit(0))
  })
}

// ─── Helpers ───────────────────────────────────────────────────

function buildTaskPrompt(
  agentName: string,
  task: { id: string; subject: string; description?: string },
  planOnly: boolean,
): string {
  const footer = planOnly
    ? 'Produce a detailed implementation plan only. Do NOT make any changes yet. Use submit_plan when done.'
    : 'Do the work now. When finished, reply with a concise summary.'

  return [
    `You are a teammate '${agentName}'.`,
    `You have been assigned task #${task.id}.`,
    `Subject: ${task.subject}`,
    '',
    `Description:\n${task.description ?? ''}`,
    '',
    footer,
  ].join('\n')
}

function extractLastAssistantText(event: { messages?: unknown[] }): string {
  if (!event.messages) return ''
  const assistants = event.messages.filter(
    m => typeof m === 'object' && m !== null && 'role' in m && (m as Record<string, unknown>).role === 'assistant',
  )
  const last = assistants[assistants.length - 1] as Record<string, unknown> | undefined
  if (!last) return ''
  const content = last.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(c => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text')
      .map(c => (c as Record<string, string>).text)
      .join('')
  }
  return ''
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}
