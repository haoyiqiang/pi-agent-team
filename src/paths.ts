/**
 * paths.ts — Filesystem path utilities for team state storage.
 *
 * Storage layout:
 *   <agentDir>/teams/<teamId>/
 *     config.json
 *     tasks/<taskListId>/<id>.json
 *     mailboxes/<namespace>/inboxes/<agent>.json
 *
 * agentDir is resolved via Pi SDK's getAgentDir(), which respects
 * the PI_CODING_AGENT_DIR env var. This ensures teams data lands
 * in the correct location when the user has a custom agent directory
 * (e.g. in dotfiles).
 *
 * Claude Code equivalent: ~/.claude/teams/<teamName>/
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

export function getMailboxDir(teamDir: string, namespace: string): string {
  return join(teamDir, 'mailboxes', namespace, 'inboxes')
}

export function getMailboxPath(teamDir: string, namespace: string, agentName: string): string {
  return join(getMailboxDir(teamDir, namespace), `${agentName}.json`)
}

export function getTasksDir(teamDir: string, taskListId: string): string {
  return join(teamDir, 'tasks', taskListId)
}

export function getTaskPath(teamDir: string, taskListId: string, taskId: string): string {
  return join(getTasksDir(teamDir, taskListId), `${taskId}.json`)
}

export function getHighWatermarkPath(teamDir: string, taskListId: string): string {
  return join(getTasksDir(teamDir, taskListId), '.highwatermark')
}
