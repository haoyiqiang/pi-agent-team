/**
 * paths.ts — Filesystem path utilities for team state storage.
 *
 * Storage layout (same convention as Claude Code):
 *   ~/.pi/agent/teams/<teamId>/
 *     config.json
 *     tasks/<taskListId>/<id>.json
 *     mailboxes/<namespace>/inboxes/<agent>.json
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const TEAMS_ROOT_NAME = 'teams'

function getPiAgentDir(): string {
  return join(homedir(), '.pi', 'agent')
}

export function getTeamsRootDir(): string {
  return join(getPiAgentDir(), TEAMS_ROOT_NAME)
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
