/**
 * team-config.ts — Team configuration file management.
 *
 * Claude Code-equivalent of teamHelpers.ts + TeamFile.
 * Team config is stored at ~/.pi/agent/teams/<teamId>/config.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { getTeamConfigPath, getTeamDir } from './paths.js'

export type MemberStatus = 'online' | 'offline' | 'idle'

export type TeamMember = {
  name: string
  role: 'lead' | 'worker'
  status: MemberStatus
  agentType?: string
  model?: string
  color?: string
  cwd?: string
  tmuxPaneId?: string
  sessionFile?: string
  joinedAt?: number
  lastSeenAt?: string
  planModeRequired?: boolean
  thinkingLevel?: string
  meta?: Record<string, unknown>
}

export type TeamConfig = {
  teamId: string
  leadName: string
  taskListId: string
  leadAgentId?: string
  createdAt: string
  leadSessionId?: string
  members: TeamMember[]
  style?: string
  hooks?: {
    enabled?: boolean
    failureAction?: string
    maxReopensPerTask?: number
    followupOwner?: string
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function ensureTeamConfig(
  teamId: string,
  defaults: {
    leadName: string
    taskListId: string
  },
): Promise<TeamConfig> {
  const existing = await loadTeamConfig(teamId)
  if (existing) return existing

  const config: TeamConfig = {
    teamId,
    leadName: defaults.leadName,
    taskListId: defaults.taskListId,
    createdAt: new Date().toISOString(),
    members: [],
  }

  await writeTeamConfig(teamId, config)
  return config
}

export async function loadTeamConfig(teamId: string): Promise<TeamConfig | null> {
  try {
    const content = await readFile(getTeamConfigPath(teamId), 'utf-8')
    return JSON.parse(content) as TeamConfig
  } catch {
    return null
  }
}

async function writeTeamConfig(teamId: string, config: TeamConfig): Promise<void> {
  const dir = getTeamDir(teamId)
  await ensureDir(dir)
  await writeFile(getTeamConfigPath(teamId), JSON.stringify(config, null, 2), 'utf-8')
}

export async function upsertMember(
  teamId: string,
  member: TeamMember,
): Promise<TeamConfig> {
  const config = (await loadTeamConfig(teamId)) ?? (await ensureTeamConfig(teamId, {
    leadName: 'team-lead',
    taskListId: teamId,
  }))

  const idx = config.members.findIndex(m => m.name === member.name)
  if (idx >= 0) {
    config.members[idx] = { ...config.members[idx], ...member }
  } else {
    config.members.push(member)
  }

  await writeTeamConfig(teamId, config)
  return config
}

export async function setMemberStatus(
  teamId: string,
  name: string,
  status: MemberStatus,
  extra?: Partial<TeamMember>,
): Promise<void> {
  const config = await loadTeamConfig(teamId)
  if (!config) return

  const member = config.members.find(m => m.name === name)
  if (!member) return

  member.status = status
  if (extra) Object.assign(member, extra)
  member.lastSeenAt = new Date().toISOString()

  await writeTeamConfig(teamId, config)
}

export async function removeMember(teamId: string, name: string): Promise<void> {
  const config = await loadTeamConfig(teamId)
  if (!config) return

  config.members = config.members.filter(m => m.name !== name)
  await writeTeamConfig(teamId, config)
}

export async function teamExists(teamId: string): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises')
    await access(getTeamConfigPath(teamId))
    return true
  } catch {
    return false
  }
}

export async function deleteTeam(teamId: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(getTeamDir(teamId), { recursive: true, force: true })
}
