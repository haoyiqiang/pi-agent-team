/**
 * task-store.ts — Shared task list with file persistence and auto-claim.
 *
 * Claude Code-equivalent of TaskCreate/Get/List/Update tools.
 * Tasks are stored as individual JSON files under:
 *   ~/.pi/agent/teams/<teamId>/tasks/<taskListId>/<id>.json
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getTasksDir, getTaskPath, getHighWatermarkPath } from './paths.js'

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type TeamTask = {
  id: string
  subject: string
  description: string
  status: TaskStatus
  owner?: string
  dependencies: string[]
  blockedBy: string[]
  createdAt: string
  startedAt?: string
  completedAt?: string
  result?: string
  metadata?: Record<string, unknown>
}

// ─── Helpers ───────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function readHighWatermark(path: string): Promise<number> {
  try {
    const content = await readFile(path, 'utf-8')
    return parseInt(content.trim(), 10) || 0
  } catch {
    return 0
  }
}

async function writeHighWatermark(path: string, value: number): Promise<void> {
  await writeFile(path, String(value), 'utf-8')
}

function now(): string {
  return new Date().toISOString()
}

// ─── CRUD ──────────────────────────────────────────────────────

export async function createTask(
  teamDir: string,
  taskListId: string,
  opts: {
    subject: string
    description?: string
    owner?: string
    dependencies?: string[]
  },
): Promise<TeamTask> {
  const tasksDir = getTasksDir(teamDir, taskListId)
  await ensureDir(tasksDir)

  const hwPath = getHighWatermarkPath(teamDir, taskListId)
  let nextId = await readHighWatermark(hwPath)
  nextId++
  await writeHighWatermark(hwPath, nextId)

  const id = String(nextId)
  const task: TeamTask = {
    id,
    subject: opts.subject,
    description: opts.description ?? '',
    status: 'pending',
    owner: opts.owner,
    dependencies: opts.dependencies ?? [],
    blockedBy: [],
    createdAt: now(),
  }

  await writeFile(getTaskPath(teamDir, taskListId, id), JSON.stringify(task, null, 2), 'utf-8')
  return task
}

export async function getTask(
  teamDir: string,
  taskListId: string,
  taskId: string,
): Promise<TeamTask | null> {
  try {
    const content = await readFile(getTaskPath(teamDir, taskListId, taskId), 'utf-8')
    return JSON.parse(content) as TeamTask
  } catch {
    return null
  }
}

export async function listTasks(
  teamDir: string,
  taskListId: string,
): Promise<TeamTask[]> {
  const tasksDir = getTasksDir(teamDir, taskListId)
  if (!existsSync(tasksDir)) return []

  const entries = await readdir(tasksDir)
  const results: TeamTask[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue
    try {
      const content = await readFile(getTaskPath(teamDir, taskListId, entry.replace('.json', '')), 'utf-8')
      results.push(JSON.parse(content) as TeamTask)
    } catch {
      // skip corrupt files
    }
  }
  return results.sort((a, b) => parseInt(a.id) - parseInt(b.id))
}

export async function updateTask(
  teamDir: string,
  taskListId: string,
  taskId: string,
  updater: (task: TeamTask) => TeamTask | null,
): Promise<TeamTask | null> {
  const existing = await getTask(teamDir, taskListId, taskId)
  if (!existing) return null

  const updated = updater({ ...existing })
  if (!updated) return null

  await writeFile(
    getTaskPath(teamDir, taskListId, taskId),
    JSON.stringify(updated, null, 2),
    'utf-8',
  )

  // Update blockedBy for dependent tasks
  if (updated.status === 'completed') {
    await resolveDependencies(teamDir, taskListId, taskId)
  }

  return updated
}

async function resolveDependencies(
  teamDir: string,
  taskListId: string,
  completedTaskId: string,
): Promise<void> {
  const allTasks = await listTasks(teamDir, taskListId)
  for (const task of allTasks) {
    if (task.dependencies.includes(completedTaskId) && task.status === 'pending') {
      // Re-check if all deps are now resolved
      const depsStillBlocked = task.dependencies.filter(depId => {
        const dep = allTasks.find(t => t.id === depId)
        return dep && dep.status !== 'completed'
      })
      if (depsStillBlocked.length === 0) {
        await updateTask(teamDir, taskListId, task.id, t => ({
          ...t,
          blockedBy: [],
        }))
      }
    }
  }
}

export async function deleteTask(
  teamDir: string,
  taskListId: string,
  taskId: string,
): Promise<boolean> {
  const path = getTaskPath(teamDir, taskListId, taskId)
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(path)
    return true
  } catch {
    return false
  }
}

// ─── Auto-Claim ────────────────────────────────────────────────

export async function claimNextAvailableTask(
  teamDir: string,
  taskListId: string,
  agentName: string,
): Promise<TeamTask | null> {
  const allTasks = await listTasks(teamDir, taskListId)

  // Find first unblocked, unowned pending task
  for (const task of allTasks) {
    if (task.status !== 'pending') continue
    if (task.owner && task.owner !== agentName) continue

    // Check dependencies
    const blocked = task.dependencies.some(depId => {
      const dep = allTasks.find(t => t.id === depId)
      return dep && dep.status !== 'completed'
    })
    if (blocked) continue

    // Claim it
    const claimed = await updateTask(teamDir, taskListId, task.id, t => {
      if (t.status !== 'pending') return null
      return {
        ...t,
        status: 'in_progress',
        owner: agentName,
        startedAt: now(),
      }
    })
    if (claimed) return claimed
  }

  return null
}

export async function completeTask(
  teamDir: string,
  taskListId: string,
  taskId: string,
  agentName: string,
  result?: string,
): Promise<TeamTask | null> {
  return updateTask(teamDir, taskListId, taskId, t => {
    if (t.owner !== agentName) return t
    return {
      ...t,
      status: 'completed',
      completedAt: now(),
      result: result ?? t.result,
    }
  })
}

export async function unassignTasksForAgent(
  teamDir: string,
  taskListId: string,
  agentName: string,
  reason?: string,
): Promise<void> {
  const allTasks = await listTasks(teamDir, taskListId)
  for (const task of allTasks) {
    if (task.owner === agentName && task.status === 'in_progress') {
      await updateTask(teamDir, taskListId, task.id, t => ({
        ...t,
        status: 'pending',
        owner: undefined,
        metadata: {
          ...t.metadata,
          unassignedAt: now(),
          unassignedReason: reason ?? 'agent left',
        },
      }))
    }
  }
}

// ─── Blocked check ─────────────────────────────────────────────

export async function isTaskBlocked(
  teamDir: string,
  taskListId: string,
  task: TeamTask,
): Promise<boolean> {
  if (task.dependencies.length === 0) return false
  const allTasks = await listTasks(teamDir, taskListId)
  return task.dependencies.some(depId => {
    const dep = allTasks.find(t => t.id === depId)
    return dep && dep.status !== 'completed'
  })
}
