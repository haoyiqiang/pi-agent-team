/**
 * identity.ts — Agent identity resolution (1:1 with Claude Code's teammate.ts)
 *
 * Two-layer identity system:
 *   1. AsyncLocalStorage (for future in-process compatibility)
 *   2. environment variables (for tmux pane teammates)
 *
 * Priority: AsyncLocalStorage > env vars
 */

import { AsyncLocalStorage } from 'node:async_hooks'

// ─── Types ─────────────────────────────────────────────────────

export type AgentIdentity = {
  agentId: string
  agentName: string
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId?: string
}

// ─── AsyncLocalStorage for process-level isolation ─────────────

const als = new AsyncLocalStorage<AgentIdentity>()

export function runWithAgentIdentity<T>(identity: AgentIdentity, fn: () => T): T {
  return als.run(identity, fn)
}

export function getIdentityFromALS(): AgentIdentity | undefined {
  return als.getStore()
}

// ─── Dynamic context (runtime join/leave) ──────────────────────

let dynamicTeamContext: AgentIdentity | null = null

export function setDynamicTeamContext(ctx: AgentIdentity | null): void {
  dynamicTeamContext = ctx
}

export function clearDynamicTeamContext(): void {
  dynamicTeamContext = null
}

export function getDynamicTeamContext(): AgentIdentity | null {
  return dynamicTeamContext
}

// ─── Environment variable helpers ──────────────────────────────

function getEnvAgentId(): string | undefined {
  const name = process.env.PI_TEAMS_AGENT_NAME
  const team = process.env.PI_TEAMS_TEAM_ID
  if (name && team) return formatAgentId(name, team)
  return undefined
}

function getEnvAgentName(): string | undefined {
  return process.env.PI_TEAMS_AGENT_NAME
}

function getEnvTeamName(): string | undefined {
  return process.env.PI_TEAMS_TEAM_ID
}

function getEnvColor(): string | undefined {
  return process.env.PI_TEAMS_COLOR
}

function getEnvPlanModeRequired(): boolean {
  return process.env.PI_TEAMS_PLAN_REQUIRED === '1'
}

function getEnvParentSessionId(): string | undefined {
  return process.env.PI_TEAMS_PARENT_SESSION_ID
}

// ─── Core identity functions (three-layer: ALS > dynamic > env) ─

/**
 * Format a deterministic agent ID: name@team
 */
export function formatAgentId(name: string, teamName: string): string {
  return `${name}@${teamName}`
}

/**
 * Get the current agent ID, or undefined if running standalone.
 */
export function getAgentId(): string | undefined {
  const alsCtx = getIdentityFromALS()
  if (alsCtx) return alsCtx.agentId
  if (dynamicTeamContext) return dynamicTeamContext.agentId
  return getEnvAgentId()
}

/**
 * Get the current agent display name.
 */
export function getAgentName(): string | undefined {
  const alsCtx = getIdentityFromALS()
  if (alsCtx) return alsCtx.agentName
  if (dynamicTeamContext) return dynamicTeamContext.agentName
  return getEnvAgentName()
}

/**
 * Get the current team name.
 */
export function getTeamName(): string | undefined {
  const alsCtx = getIdentityFromALS()
  if (alsCtx) return alsCtx.teamName
  if (dynamicTeamContext) return dynamicTeamContext.teamName
  return getEnvTeamName()
}

/**
 * Check if this session is running as a teammate.
 */
export function isTeammate(): boolean {
  const alsCtx = getIdentityFromALS()
  if (alsCtx) return true
  if (dynamicTeamContext) return true
  // tmux teammate: must have both agent name AND team name
  return !!(getEnvAgentName() && getEnvTeamName())
}

/**
 * Check if this session is a team lead.
 * A session is team lead if:
 *   1. teamContext has a leadAgentId, AND
 *   2. either: our agentId matches leadAgentId, OR we have no agentId set
 */
export function isTeamLead(teamContext?: { leadAgentId: string } | null): boolean {
  if (!teamContext?.leadAgentId) return false
  const myId = getAgentId()
  if (myId === teamContext.leadAgentId) return true
  // Backwards compat: if no agentId is set, we're the original session
  if (!myId) return true
  return false
}

/**
 * Get teammate color if running as a teammate.
 */
export function getTeammateColor(): string | undefined {
  const alsCtx = getIdentityFromALS()
  if (alsCtx) return alsCtx.color
  if (dynamicTeamContext) return dynamicTeamContext.color
  return getEnvColor()
}

/**
 * Check if plan mode is required for this teammate.
 */
export function isPlanModeRequired(): boolean {
  const alsCtx = getIdentityFromALS()
  if (alsCtx) return alsCtx.planModeRequired
  if (dynamicTeamContext) return dynamicTeamContext.planModeRequired
  return getEnvPlanModeRequired()
}

/**
 * Get the parent session ID (team lead's session).
 */
export function getParentSessionId(): string | undefined {
  const alsCtx = getIdentityFromALS()
  if (alsCtx) return alsCtx.parentSessionId
  if (dynamicTeamContext) return dynamicTeamContext.parentSessionId
  return getEnvParentSessionId()
}

/**
 * Build teammate environment variables for spawning.
 * Mirrors Claude Code's --agent-id, --team-name, etc.
 */
export function buildTeammateEnvVars(opts: {
  agentName: string
  teamName: string
  model?: string
  planModeRequired?: boolean
  autoClaim?: boolean
  thinkingLevel?: string
  color?: string
  parentSessionId?: string
}): Record<string, string> {
  return {
    PI_TEAMS_WORKER: '1',
    PI_TEAMS_TEAM_ID: opts.teamName,
    PI_TEAMS_AGENT_NAME: opts.agentName,
    PI_TEAMS_LEAD_NAME: 'team-lead',
    PI_TEAMS_AUTO_CLAIM: opts.autoClaim !== false ? '1' : '0',
    PI_TEAMS_TASK_LIST_ID: opts.teamName,
    ...(opts.model ? { PI_TEAMS_MODEL: opts.model } : {}),
    ...(opts.planModeRequired ? { PI_TEAMS_PLAN_REQUIRED: '1' } : {}),
    ...(opts.thinkingLevel ? { PI_TEAMS_THINKING_LEVEL: opts.thinkingLevel } : {}),
    ...(opts.color ? { PI_TEAMS_COLOR: opts.color } : {}),
    ...(opts.parentSessionId ? { PI_TEAMS_PARENT_SESSION_ID: opts.parentSessionId } : {}),
  }
}
