/**
 * leader.ts — Team leader logic (1:1 with Claude Code)
 *
 * Full feature set:
 * - Team creation with deterministic agentId, session registration, cleanup tracking
 * - Tmux pane spawning with grid layout, lock, shell delay
 * - Task management (create/get/list/update/delete) with dependencies
 * - Plan approval workflow (receive request → approve/reject → route back)
 * - Quality gate hooks (task completed/failed → exec scripts)
 * - Permission request routing (worker → leader model → response)
 * - Batch shutdown with handshake wait
 * - Orphan team cleanup on session restart
 * - Leader inbox polling (700ms)
 * - Widget with color-coded status icons
 * - /team, /tw, /swarm commands
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { randomUUID } from 'node:crypto'
import { writeToMailbox, popUnreadMessages, readMailbox, isStructuredProtocolMessage } from './mailbox.js'
import {
  createTask, listTasks, getTask, updateTask, deleteTask as deleteTaskFromStore,
  unassignTasksForAgent, claimNextAvailableTask, completeTask,
} from './task-store.js'
import {
  ensureTeamConfig, loadTeamConfig, setMemberStatus,
  upsertMember, removeMember, teamExists, deleteTeam,
} from './team-config.js'
import type { TeamConfig, TeamMember } from './team-config.js'
import {
  createTeammatePane, setPaneBorderColor, sendCommandToPane,
  killPane, enablePaneBorderStatus, rebalancePanes,
  getPiLaunchCommand, isInsideTmux,
} from './spawn.js'
import { shutdownTeammate } from './lifecycle.js'
import {
  sanitizeName, sanitizePathComponent, formatAgentId,
} from './names.js'
import { buildTeammateEnvVars, getTeamName, isTeamLead, getAgentId } from './identity.js'
import { getTeamDir, getTeamsRootDir, getTeamConfigPath } from './paths.js'
import {
  TEAM_MAILBOX_NS,
  isIdleNotification, isPlanApprovalRequest, isPermissionRequest, isPermissionResponse,
  isShutdownApproved, isShutdownRejected, IDLE_TTL_MS,
  PROTOCOL_MESSAGE_TYPES,
} from './protocol.js'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// ─── Colors ────────────────────────────────────────────────────

const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']
let colorIndex = 0
function nextColor(): string {
  const c = AGENT_COLORS[colorIndex % AGENT_COLORS.length]!
  colorIndex++
  return c
}

// ─── Type for in-memory teammate tracking ──────────────────────

type TeammateInfo = {
  name: string
  agentId: string
  paneId: string
  color: string
  model?: string
  planModeRequired?: boolean
  agentType?: string
  status: 'starting' | 'idle' | 'streaming' | 'stopped' | 'error'
  currentTaskId?: string
  lastEventAt: number
}

// ─── Session team cleanup registry ─────────────────────────────

const SESSION_TEAMS_KEY = Symbol.for('pi-teams-tmux:sessionTeams')

function getSessionTeams(): Set<string> {
  const g = globalThis as Record<symbol, unknown>
  if (!g[SESSION_TEAMS_KEY]) g[SESSION_TEAMS_KEY] = new Set<string>()
  return g[SESSION_TEAMS_KEY] as Set<string>
}

function registerTeamForSessionCleanup(teamId: string): void {
  getSessionTeams().add(teamId)
}

function unregisterTeamForSessionCleanup(teamId: string): void {
  getSessionTeams().delete(teamId)
}

// ─── Orphan cleanup on startup ─────────────────────────────────

async function cleanupOrphanTeams(): Promise<void> {
  const teamsRoot = getTeamsRootDir()
  if (!existsSync(teamsRoot)) return
  const { readdir } = await import('node:fs/promises')
  let dirs: string[]
  try { dirs = await readdir(teamsRoot) } catch { return }

  for (const teamId of dirs) {
    if (getSessionTeams().has(teamId)) continue
    const configPath = getTeamConfigPath(teamId)
    if (!existsSync(configPath)) continue
    try {
      const config: TeamConfig = JSON.parse(await (await import('node:fs/promises')).readFile(configPath, 'utf-8'),
      )
      // Only clean up teams older than 1 hour whose lead session is stale
      const createdAt = new Date(config.createdAt).getTime()
      if (Date.now() - createdAt > 3600_000) {
        // Check if leader member still has status 'online'
        const leadMember = config.members.find(m => m.role === 'lead')
        if (!leadMember || leadMember.status === 'offline') {
          // Kill any remaining worker panes referenced in config
          for (const m of config.members) {
            if (m.tmuxPaneId) {
              try { execFileSync('tmux', ['kill-pane', '-t', m.tmuxPaneId], { timeout: 3000 }) } catch { /* ignore */ }
            }
          }
          await deleteTeam(teamId)
        }
      }
    } catch { /* ignore */ }
  }
}

// ─── Quality gate hooks ────────────────────────────────────────

const HOOKS_DIR = join(getTeamsRootDir(), '_hooks')

async function executeHook(
  event: 'on_task_completed' | 'on_task_failed' | 'on_idle',
  context: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Check for hook scripts in _hooks directory
  const scriptPath = join(HOOKS_DIR, `${event}.sh`)
  if (!existsSync(scriptPath)) {
    // Check for .js variant
    const jsPath = join(HOOKS_DIR, `${event}.js`)
    if (!existsSync(jsPath)) return { exitCode: 0, stdout: '', stderr: '' }
    try {
      const result = execFileSync(process.execPath, [jsPath], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, ...context },
      })
      return { exitCode: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number }
      return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
  }
  try {
    const result = execFileSync('/bin/sh', [scriptPath], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, ...context },
    })
    return { exitCode: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

// ─── Entry point ───────────────────────────────────────────────

export function runLeader(pi: ExtensionAPI): void {
  const teammates = new Map<string, TeammateInfo>()
  let currentCtx: ExtensionContext | null = null
  let currentTeamId: string | null = null
  let currentTaskListId: string | null = null

  // ─── Helpers ───────────────────────────────────────────

  function td(): string | null {
    return currentTeamId ? getTeamDir(currentTeamId) : null
  }

  function tl(): string {
    return currentTaskListId ?? currentTeamId ?? '(no team)'
  }

  // ─── Widget ─────────────────────────────────────────────

  let widgetSuppressed = false

  const renderWidgetText = (): string => {
    const lines: string[] = []
    lines.push(`Team: ${currentTeamId ?? '(none)'}`)
    if (teammates.size === 0) {
      lines.push('  No teammates')
    } else {
      for (const [, t] of teammates) {
        const icon =
          t.status === 'streaming' ? '⠹' :
          t.status === 'idle' ? '○' :
          t.status === 'starting' ? '◌' :
          t.status === 'stopped' ? '■' : '✗'
        const taskInfo = t.currentTaskId ? ` #${t.currentTaskId}` : ''
        lines.push(`  ${icon} ${t.name}${taskInfo} (${t.status})`)
      }
    }
    return lines.join('\n')
  }
  const renderWidget = () => {
    if (!currentCtx || widgetSuppressed) return
    try {
      currentCtx.ui.setWidget('pi-teams-tmux', renderWidgetText().split('\n'))
    } catch { /* widget best-effort */ }
  }

  // ─── Leader inbox polling ──────────────────────────────

  let inboxTimer: ReturnType<typeof setInterval> | null = null
  const seenIdleNotifs = new Map<string, number>() // key → timestamp

  const pollLeaderInbox = async () => {
    const teamDir = td()
    if (!teamDir || !currentCtx) return

    try {
      const msgs = await readMailbox(teamDir, TEAM_MAILBOX_NS, 'team-lead')

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]!
        if (msg.read) continue

        // Skip structured protocol messages that need processing before LLM sees them
        if (isStructuredProtocolMessage(msg.text)) {
          const parsed = tryParseJson(msg.text)
          if (!parsed) continue

          // ── Idle notification from worker ─────────────
          if (isIdleNotification(parsed)) {
            const { markAsReadByIndex } = await import('./mailbox.js')
            await markAsReadByIndex(teamDir, TEAM_MAILBOX_NS, 'team-lead', i)

            const teammate = teammates.get(parsed.from)
            if (teammate) {
              teammate.status = 'idle'
              teammate.lastEventAt = Date.now()
              if (parsed.completedTaskId) teammate.currentTaskId = undefined
            }

            // Execute quality gate hook on task completion/failure
            if (parsed.completedTaskId) {
              const isFailed = parsed.completedStatus === 'failed'
              const hookEvent = isFailed ? 'on_task_failed' : 'on_task_completed'
              const hookCtx = {
                PI_TEAMS_TEAM_ID: currentTeamId ?? '',
                PI_TEAMS_EVENT: hookEvent,
                PI_TEAMS_MEMBER: parsed.from,
                PI_TEAMS_TASK_ID: parsed.completedTaskId,
                PI_TEAMS_TASK_STATUS: parsed.completedStatus ?? 'completed',
              }
              void executeHook(hookEvent, hookCtx)

              // Notify the leader LLM
              const statusLabel = parsed.completedStatus === 'failed' ? 'failed' : 'completed'
              pi.sendUserMessage(
                `[Team] Teammate '${parsed.from}' ${statusLabel} task #${parsed.completedTaskId}.`,
                { deliverAs: 'followUp', triggerTurn: true },
              )
            }

            renderWidget()
            continue
          }

          // ── Plan approval request from worker ──────────
          if (isPlanApprovalRequest(parsed)) {
            const { markAsReadByIndex } = await import('./mailbox.js')
            await markAsReadByIndex(teamDir, TEAM_MAILBOX_NS, 'team-lead', i)

            // Forward to leader LLM for decision
            const taskInfo = parsed.taskId ? ` (task #${parsed.taskId})` : ''
            pi.sendUserMessage(
              `[Team] Teammate '${parsed.from}' requests plan approval${taskInfo}.\n\n` +
              `Plan:\n${parsed.plan}\n\n` +
              `Respond with a plan_approval_request or plan_rejection using the send_message tool to '${parsed.from}'.`,
              { deliverAs: 'followUp', triggerTurn: true },
            )
            continue
          }

          // ── Permission request from worker ─────────────
          if (isPermissionRequest(parsed)) {
            const { markAsReadByIndex } = await import('./mailbox.js')
            await markAsReadByIndex(teamDir, TEAM_MAILBOX_NS, 'team-lead', i)

            pi.sendUserMessage(
              `[Team] Teammate '${parsed.from}' requests permission for tool "${parsed.toolName}".\n\n` +
              `Arguments: ${parsed.args}\n\n` +
              `Respond with permission_response to '${parsed.from}' using the send_message tool.`,
              { deliverAs: 'followUp', triggerTurn: true },
            )
            continue
          }

          // ── Shutdown response from worker ──────────────
          if (isShutdownApproved(parsed) || isShutdownRejected(parsed)) {
            // Handled by lifecycle.ts's polling loop. Just mark as read.
            const { markAsReadByIndex } = await import('./mailbox.js')
            await markAsReadByIndex(teamDir, TEAM_MAILBOX_NS, 'team-lead', i)
            continue
          }
        }
      }
    } catch {
      // ignore polling errors
    }
  }

  // ─── Tool: team_create (1:1 with Claude Code's TeamCreateTool) ─

  pi.registerTool({
    name: 'team_create',
    label: 'Create Team',
    description: 'Create a new team. Creates team file, initializes task list, registers lead identity.',
    parameters: Type.Object({
      team_name: Type.String({ description: 'Name for the new team' }),
      description: Type.Optional(Type.String()),
      agent_type: Type.Optional(Type.String({ description: 'Role/type of team lead (e.g. "researcher")' })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const teamName = sanitizeName(params.team_name)
      if (currentTeamId) {
        throw new Error(`Already leading team "${currentTeamId}". Use team_shutdown first.`)
      }
      if (await teamExists(teamName)) {
        throw new Error(`Team "${teamName}" already exists.`)
      }

      currentTeamId = teamName
      currentTaskListId = teamName
      currentCtx = ctx

      // Generate deterministic lead agent ID (Claude Code: formatAgentId(TEAM_LEAD_NAME, teamName))
      const leadAgentId = formatAgentId('team-lead', teamName)

      const config = await ensureTeamConfig(teamName, {
        leadName: 'team-lead',
        taskListId: teamName,
      })
      config.leadSessionId = ctx.sessionManager.getSessionId()
      config.leadAgentId = leadAgentId
      // Write back with session ID
      const { writeFile: writeCfg } = await import('node:fs/promises')
      await writeCfg(getTeamConfigPath(teamName), JSON.stringify(config, null, 2), 'utf-8')

      // Add leader as member (Claude Code stores leadAgentId in TeamFile)
      await upsertMember(teamName, {
        name: 'team-lead',
        role: 'lead',
        status: 'online',
        cwd: ctx.cwd,
        agentType: params.agent_type,
        joinedAt: Date.now(),
        tmuxPaneId: process.env.TMUX_PANE ?? undefined,
      })

      // Register for session cleanup (Claude Code: registerTeamForSessionCleanup)
      registerTeamForSessionCleanup(teamName)

      // Start inbox polling (Claude Code: 700ms as in worker inbox polling)
      if (inboxTimer) clearInterval(inboxTimer)
      inboxTimer = setInterval(pollLeaderInbox, 700)
      inboxTimer.unref?.()

      renderWidget()

      return {
        content: [{ type: 'text', text: `Team '${teamName}' created (lead: ${leadAgentId}). Use spawn_teammate to add members.` }],
        details: { team_name: teamName, lead_agent_id: leadAgentId },
      }
    },
  })

  // ─── Tool: spawn_teammate (1:1 with Claude Code's AgentTool team branch) ─

  pi.registerTool({
    name: 'spawn_teammate',
    label: 'Spawn Teammate',
    description: 'Spawn a teammate in a new tmux pane with full identity and communication channels.',
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String({ description: 'Teammate name' }),
      prompt: Type.String({ description: 'Initial instructions' }),
      cwd: Type.String(),
      model: Type.Optional(Type.String()),
      agent_type: Type.Optional(Type.String({ description: 'Role/agent type' })),
      plan_mode_required: Type.Optional(Type.Boolean({ default: false })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const safeName = sanitizeName(params.name)
      const safeTeam = sanitizeName(params.team_name)
      const teamDir = getTeamDir(safeTeam)

      if (!await teamExists(safeTeam)) {
        throw new Error(`Team "${safeTeam}" does not exist.`)
      }
      if (teammates.has(safeName)) {
        throw new Error(`Teammate "${safeName}" already exists.`)
      }

      const color = nextColor()
      const agentId = formatAgentId(safeName, safeTeam)

      // Create tmux pane (async with lock)
      const paneId = await createTeammatePane(safeName, color, teammates.size + 1)

      // Style pane
      setPaneBorderColor(paneId, color)

      // Register in team config
      await upsertMember(safeTeam, {
        name: safeName,
        role: 'worker',
        status: 'online',
        agentType: params.agent_type,
        model: params.model,
        color,
        cwd: params.cwd,
        tmuxPaneId: paneId,
        joinedAt: Date.now(),
        planModeRequired: params.plan_mode_required,
      })

      // Track locally
      teammates.set(safeName, {
        name: safeName,
        agentId,
        paneId,
        color,
        model: params.model,
        planModeRequired: params.plan_mode_required,
        agentType: params.agent_type,
        status: 'starting',
        lastEventAt: Date.now(),
      })

      // Build spawn command with env vars (Claude Code: buildTeammateEnv)
      const piBinary = getPiLaunchCommand()
      const env = buildTeammateEnvVars({
        agentName: safeName,
        teamName: safeTeam,
        model: params.model,
        planModeRequired: params.plan_mode_required,
        color,
        parentSessionId: ctx.sessionManager.getSessionId(),
      })
      const envStr = Object.entries(env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')
      const spawnCommand = `cd ${JSON.stringify(params.cwd)} && ${envStr} ${piBinary} --no-extensions`

      // Send to pane (async, includes shell init delay)
      await sendCommandToPane(paneId, spawnCommand)

      // Send initial prompt via mailbox
      const ts = new Date().toISOString()
      await writeToMailbox(teamDir, TEAM_MAILBOX_NS, safeName, {
        from: 'team-lead',
        text: params.prompt,
        timestamp: ts,
        summary: 'Initial instructions',
      })

      // Enable border status for first teammate (Claude Code style)
      if (teammates.size === 1) enablePaneBorderStatus()

      // Rebalance to main-vertical layout (Claude Code: leader 30%, teammates 70%)
      rebalancePanes()

      renderWidget()

      return {
        content: [{ type: 'text', text: `Teammate '${safeName}' spawned (${agentId}) in pane ${paneId} (${color}).` }],
        details: { name: safeName, agentId, paneId, color, team_name: safeTeam },
      }
    },
  })

  // ─── Tool: task_create ────────────────────────────────

  pi.registerTool({
    name: 'task_create',
    label: 'Create Task',
    description: 'Create a shared task. Notifies assigned teammate via mailbox.',
    parameters: Type.Object({
      team_name: Type.String(),
      subject: Type.String(),
      description: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
      dependencies: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const teamDir = getTeamDir(sanitizeName(params.team_name))
      const taskListId = sanitizeName(params.team_name)
      const task = await createTask(teamDir, taskListId, {
        subject: params.subject,
        description: params.description,
        owner: params.owner ? sanitizeName(params.owner) : undefined,
        dependencies: params.dependencies,
      })

      if (params.owner) {
        const ts = new Date().toISOString()
        await writeToMailbox(teamDir, TEAM_MAILBOX_NS, sanitizeName(params.owner), {
          from: 'team-lead',
          text: JSON.stringify({ type: 'task_assignment', taskId: task.id, from: 'team-lead', subject: task.subject, timestamp: ts }),
          timestamp: ts,
        })
      }

      renderWidget()
      return { content: [{ type: 'text', text: `Task #${task.id} created.` }], details: { task } }
    },
  })

  // ─── Tool: task_list ──────────────────────────────────

  pi.registerTool({
    name: 'task_list',
    label: 'List Tasks',
    description: 'List all tasks with status.',
    parameters: Type.Object({ team_name: Type.String() }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const teamDir = getTeamDir(sanitizeName(params.team_name))
      const tasks = await listTasks(teamDir, sanitizeName(params.team_name))
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }], details: { tasks } }
    },
  })

  // ─── Tool: task_get ───────────────────────────────────

  pi.registerTool({
    name: 'task_get',
    label: 'Get Task',
    description: 'Get a single task.',
    parameters: Type.Object({ team_name: Type.String(), task_id: Type.String() }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const teamDir = getTeamDir(sanitizeName(params.team_name))
      const task = await getTask(teamDir, sanitizeName(params.team_name), params.task_id)
      if (!task) throw new Error(`Task #${params.task_id} not found.`)
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }], details: { task } }
    },
  })

  // ─── Tool: task_update ────────────────────────────────

  pi.registerTool({
    name: 'task_update',
    label: 'Update Task',
    description: 'Update task status or owner. Triggers quality gate hooks on completion.',
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      status: Type.Optional(Type.Union([
        Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed'),
      ])),
      owner: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const safeTeam = sanitizeName(params.team_name)
      const teamDir = getTeamDir(safeTeam)
      const taskListId = safeTeam

      const updated = await updateTask(teamDir, taskListId, params.task_id, t => {
        const next = { ...t }
        if (params.status) next.status = params.status
        if (params.owner !== undefined) next.owner = sanitizeName(params.owner)
        if (params.status === 'completed') {
          next.completedAt = new Date().toISOString()
          // Execute quality gate hook asynchronously
          void executeHook('on_task_completed', {
            PI_TEAMS_TEAM_ID: safeTeam,
            PI_TEAMS_EVENT: 'on_task_completed',
            PI_TEAMS_TASK_ID: params.task_id,
            PI_TEAMS_TASK_STATUS: 'completed',
            PI_TEAMS_MEMBER: t.owner ?? '',
          })
        }
        return next
      })
      if (!updated) throw new Error(`Task #${params.task_id} not found.`)
      renderWidget()
      return { content: [{ type: 'text', text: `Task #${params.task_id} updated.` }], details: { task: updated } }
    },
  })

  // ─── Tool: send_message ───────────────────────────────

  pi.registerTool({
    name: 'send_message',
    label: 'Send Message',
    description: 'Send a message to a teammate. Use for DMs, plan approval responses, and permission responses.',
    parameters: Type.Object({
      team_name: Type.String(),
      recipient: Type.String(),
      content: Type.String(),
      summary: Type.Optional(Type.String()),
      urgent: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const teamDir = getTeamDir(sanitizeName(params.team_name))
      const ts = new Date().toISOString()
      await writeToMailbox(teamDir, TEAM_MAILBOX_NS, sanitizeName(params.recipient), {
        from: 'team-lead',
        text: params.content,
        timestamp: ts,
        summary: params.summary,
        urgent: params.urgent,
      })
      // If the content contains a structured permission_response, also deliver as steer for immediate effect
      const parsed = tryParseJson(params.content)
      if (parsed && isPermissionResponse(parsed)) {
        // Urgent delivery for permission responses
        await writeToMailbox(teamDir, TEAM_MAILBOX_NS, sanitizeName(params.recipient), {
          from: 'team-lead',
          text: params.content,
          timestamp: ts,
          summary: 'Permission response',
          urgent: true,
        })
      }
      // If this is a plan approval/rejection, also send a followUp to the worker
      if (parsed && (parsed.type === 'plan_approved' || parsed.type === 'plan_rejected')) {
        await writeToMailbox(teamDir, TEAM_MAILBOX_NS, sanitizeName(params.recipient), {
          from: 'team-lead',
          text: params.content,
          timestamp: ts,
          summary: parsed.type === 'plan_approved' ? 'Plan approved' : 'Plan rejected',
          urgent: true,
        })
      }
      return { content: [{ type: 'text', text: `Message sent to ${params.recipient}.` }] }
    },
  })

  // ─── Tool: broadcast_message ──────────────────────────

  pi.registerTool({
    name: 'broadcast_message',
    label: 'Broadcast Message',
    description: 'Broadcast a message to all teammates.',
    parameters: Type.Object({
      team_name: Type.String(),
      content: Type.String(),
      urgent: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const teamDir = getTeamDir(sanitizeName(params.team_name))
      const config = await loadTeamConfig(sanitizeName(params.team_name))
      if (!config) throw new Error(`Team not found.`)

      const ts = new Date().toISOString()
      for (const member of config.members) {
        if (member.role === 'lead') continue
        await writeToMailbox(teamDir, TEAM_MAILBOX_NS, member.name, {
          from: 'team-lead',
          text: params.content,
          timestamp: ts,
          urgent: params.urgent,
        })
      }
      return { content: [{ type: 'text', text: 'Broadcast sent to all teammates.' }] }
    },
  })

  // ─── Tool: team_shutdown (with batch wait) ────────────

  pi.registerTool({
    name: 'team_shutdown',
    label: 'Shutdown Teammate',
    description: 'Graceful shutdown via handshake. Omit name to shut down all with batch wait.',
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const safeTeam = sanitizeName(params.team_name)
      const teamDir = getTeamDir(safeTeam)

      if (params.name) {
        const safeName = sanitizeName(params.name)
        const info = teammates.get(safeName)
        const { shutdownTeammate: shutdown } = await import('./lifecycle.js')
        await shutdown(teamDir, safeTeam, safeName, {
          reason: params.reason,
          paneId: info?.paneId,
        })
        teammates.delete(safeName)
        renderWidget()
        return { content: [{ type: 'text', text: `Teammate '${safeName}' shut down.` }] }
      }

      // Batch shutdown: send requests to all, wait for responses, then force-kill stragglers (1:1 with Claude Code)
      const results: string[] = []
      for (const [name, info] of teammates) {
        const { shutdownTeammate: shutdown } = await import('./lifecycle.js')
        const ok = await shutdown(teamDir, safeTeam, name, {
          reason: params.reason,
          paneId: info.paneId,
        })
        results.push(`${name}: ${ok ? 'shutdown' : 'timeout/force-killed'}`)
      }
      teammates.clear()
      hideWidget()
      return { content: [{ type: 'text', text: `Shutdown results:\n${results.join('\n')}` }] }
    },
  })

  // ─── Tool: team_kill ──────────────────────────────────

  pi.registerTool({
    name: 'team_kill',
    label: 'Kill Teammate',
    description: 'Force-kill a teammate immediately.',
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const safeName = sanitizeName(params.name)
      const info = teammates.get(safeName)
      if (!info) throw new Error(`Teammate "${safeName}" not found.`)

      killPane(info.paneId)
      teammates.delete(safeName)

      const safeTeam = sanitizeName(params.team_name)
      await removeMember(safeTeam, safeName)
      await unassignTasksForAgent(getTeamDir(safeTeam), safeTeam, safeName, 'killed')
      renderWidget()
      return { content: [{ type: 'text', text: `Teammate '${safeName}' killed.` }] }
    },
  })

  // ─── Session handlers ─────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    currentCtx = ctx
    // Orphan cleanup on startup
    void cleanupOrphanTeams()
  })

  pi.on('session_shutdown', async () => {
    if (inboxTimer) {
      clearInterval(inboxTimer)
      inboxTimer = null
    }

    // Graceful shutdown of all teammates
    for (const [, info] of teammates) {
      try { killPane(info.paneId) } catch { /* ignore */ }
    }
    teammates.clear()

    // Clean up teams registered to this session
    for (const teamId of getSessionTeams()) {
      try { await deleteTeam(teamId) } catch { /* ignore */ }
    }
    getSessionTeams().clear()
  })

  // ─── Commands ────────────────────────────────────────

  pi.registerCommand('team', {
    description: 'Team management commands',
    handler: async (args, ctx) => {
      currentCtx = ctx
      const parts = args.trim().split(/\s+/)
      const subcmd = parts[0]?.toLowerCase()

      if (!subcmd || subcmd === 'help') {
        ctx.ui.notify(
          'Team commands:\n' +
          '  /team spawn <name> [--model M] [--plan] [--type T]  — Spawn a teammate\n' +
          '  /team list                                           — List teammates\n' +
          '  /team task add <name>: <subject>                    — Create task\n' +
          '  /team task list                                      — List tasks\n' +
          '  /team task assign <id> <name>                       — Assign task\n' +
          '  /team dm <name> <msg>                               — Direct message\n' +
          '  /team broadcast <msg>                                — Broadcast\n' +
          '  /team shutdown [name]                                — Graceful shutdown\n' +
          '  /team kill <name>                                    — Force kill\n' +
          '  /team done                                           — End team session\n' +
          '  /team cleanup                                        — Delete team artifacts\n' +
          '  /tw                                                  — Open widget panel',
          'info',
        )
        return
      }

      if (subcmd === 'list') {
        if (teammates.size === 0) {
          ctx.ui.notify('No teammates.', 'info')
          return
        }
        const lines = Array.from(teammates.entries()).map(([name, info]) =>
          `  ${info.status === 'streaming' ? '⠹' : '○'} ${name} (${info.status})${info.currentTaskId ? ` task #${info.currentTaskId}` : ''}`,
        )
        ctx.ui.notify(`Teammates (${teammates.size}):\n${lines.join('\n')}`, 'info')
        return
      }

      if (subcmd === 'done') {
        if (!currentTeamId) { ctx.ui.notify('No active team.', 'info'); return }
        if (inboxTimer) { clearInterval(inboxTimer); inboxTimer = null }
        for (const [, info] of teammates) { try { killPane(info.paneId) } catch { /* ignore */ } }
        teammates.clear()
        hideWidget()
        ctx.ui.notify(`Team '${currentTeamId}' ended.`, 'info')
        return
      }

      if (subcmd === 'cleanup') {
        if (!currentTeamId) { ctx.ui.notify('No active team.', 'info'); return }
        await deleteTeam(currentTeamId)
        unregisterTeamForSessionCleanup(currentTeamId)
        currentTeamId = null
        hideWidget()
        ctx.ui.notify('Team artifacts cleaned up.', 'info')
        return
      }

      // Delegate complex commands to LLM
      pi.sendUserMessage(
        `Handle this team command using your tools: ${args}`,
        { deliverAs: 'followUp', triggerTurn: true },
      )
    },
  })

  pi.registerCommand('tw', {
    description: 'Teams: open widget panel',
    handler: async (_args, ctx) => {
      currentCtx = ctx
      restoreWidget()
      if (!currentTeamId) {
        ctx.ui.notify('No active team. Create one with team_create tool.', 'info')
        return
      }
      ctx.ui.notify(renderWidgetText(), 'info')
    },
  })

  pi.registerCommand('swarm', {
    description: 'Start a team of agents to work on a task',
    handler: async (args, _ctx) => {
      const task = args.trim()
      if (!task) {
        pi.sendUserMessage('Use your tools to create a team and delegate work. Ask me what I need done.')
        return
      }
      pi.sendUserMessage(`Use your team tools to create a team and delegate:\n\n${task}`)
    },
  })
}

// ─── Helpers ───────────────────────────────────────────────────

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}
