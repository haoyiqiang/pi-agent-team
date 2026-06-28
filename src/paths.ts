/**
 * paths.ts — Filesystem path utilities (1:1 with Claude Code)
 *
 * Storage layout (matching Claude Code exactly):
 *   <agentDir>/teams/<teamId>/
 *     config.json              ← team config (Claude: team.json)
 *     inboxes/<agent>.json     ← per-agent inbox
 *   <agentDir>/tasks/<taskListId>/<id>.json  ← tasks (Claude: same)
 *
 * Claude Code original:
 *   ~/.claude/teams/<teamName>/team.json
 *   ~/.claude/teams/<teamName>/inboxes/<agent>.json
 *   ~/.claude/tasks/<taskListId>/<id>.json
 *
 * agentDir is resolved via Pi SDK's getAgentDir(), respecting
 * PI_CODING_AGENT_DIR env var.
 */

import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const TEAMS_ROOT_NAME = 'teams'

export function getTeamsRootDir(): string {
  return join(getAgentDir(), TEAMS_ROOT_NAME)
}

export function getTeamDir(teamId: string): string {
  return join(getTeamsRootDir(), teamId)
}

export function getTeamConfigPath(teamId: string): string {
  return join(getTeamDir(teamId), 'config.json')
}

/** Claude Code: ~/.claude/teams/<teamName>/inboxes/<agent>.json */
export function getInboxPath(teamDir: string, agentName: string): string {
  return join(teamDir, 'inboxes', `${agentName}.json`)
}

/** Claude Code: ~/.claude/tasks/<taskListId>/ */
export function getTasksDir(taskListId: string): string {
  return join(getAgentDir(), 'tasks', taskListId)
}

/** Claude Code: ~/.claude/tasks/<taskListId>/<id>.json */
export function getTaskPath(taskListId: string, taskId: string): string {
  return join(getTasksDir(taskListId), `${taskId}.json`)
}

/** High-watermark for sequential task IDs. */
export function getHighWatermarkPath(taskListId: string): string {
  return join(getTasksDir(taskListId), '.highwatermark')
}
