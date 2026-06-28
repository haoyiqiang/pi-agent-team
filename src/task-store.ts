/**
 * task-store.ts — Shared task list (1:1 with Claude Code's Task tools)
 *
 * Claude Code: ~/.claude/tasks/<taskListId>/<id>.json
 * Pi:          <agentDir>/tasks/<taskListId>/<id>.json
 *
 * Tasks are stored at the agentDir level (not under team dir), matching
 * Claude Code's layout exactly.
 */

import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function readHighWatermark(path: string): Promise<number> {
  try {
    const content = await readFile(path, 'utf-8')
    return parseInt(content.trim(), 10) || 0
  } catch { return 0 }
}

async function writeHighWatermark(path: string, value: number): Promise<void> {
  await writeFile(path, String(value), 'utf-8')
}

function now(): string {
  return new Date().toISOString()
}

/** Create a task with sequential numeric ID. */
export async function createTask(
  taskListId: string,
  opts: {
    subject: string
    description?: string
    owner?: string
    dependencies?: string[]
  },
): Promise<TeamTask> {
  const tasksDir = getTasksDir(taskListId)
  await ensureDir(tasksDir)

  const hwPath = getHighWatermarkPath(taskListId)
  let nextId = await readHighWatermark(hwPath)
  nextId++
  await writeHighWatermark(hwPath, nextId)

  const id = String(nextId)
  const task: TeamTask = {
    id, subject: opts.subject, description: opts.description ?? '',
    status: 'pending', owner: opts.owner,
    dependencies: opts.dependencies ?? [], blockedBy: [],
    createdAt: now(),
  }

  await writeFile(getTaskPath(taskListId, id), JSON.stringify(task, null, 2), 'utf-8')
  return task
}

/** Get a single task. */
export async function getTask(taskListId: string, taskId: string): Promise<TeamTask | null> {
  try {
    const content = await readFile(getTaskPath(taskListId, taskId), 'utf-8')
    return JSON.parse(content) as TeamTask
  } catch { return null }
}

/** List all tasks sorted by ID. */
export async function listTasks(taskListId: string): Promise<TeamTask[]> {
  const tasksDir = getTasksDir(taskListId)
  if (!existsSync(tasksDir)) return []

  const entries = await readdir(tasksDir)
  const results: TeamTask[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue
    try {
      const content = await readFile(getTaskPath(taskListId, entry.replace('.json', '')), 'utf-8')
      results.push(JSON.parse(content) as TeamTask)
    } catch { /* skip corrupt */ }
  }
  return results.sort((a, b) => parseInt(a.id) - parseInt(b.id))
}

/** Update a task. Return null if not found. */
export async function updateTask(
  taskListId: string, taskId: string,
  updater: (task: TeamTask) => TeamTask | null,
): Promise<TeamTask | null> {
  const existing = await getTask(taskListId, taskId)
  if (!existing) return null

  const updated = updater({ ...existing })
  if (!updated) return null

  await writeFile(getTaskPath(taskListId, taskId), JSON.stringify(updated, null, 2), 'utf-8')

  // Update blockedBy for dependent tasks
  if (updated.status === 'completed') {
    await resolveDependencies(taskListId, taskId)
  }

  return updated
}

async function resolveDependencies(taskListId: string, completedTaskId: string): Promise<void> {
  const allTasks = await listTasks(taskListId)
  for (const task of allTasks) {
    if (task.dependencies.includes(completedTaskId) && task.status === 'pending') {
      const stillBlocked = task.dependencies.filter(depId => {
        const dep = allTasks.find(t => t.id === depId)
        return dep && dep.status !== 'completed'
      })
      if (stillBlocked.length === 0) {
        await updateTask(taskListId, task.id, t => ({ ...t, blockedBy: [] }))
      }
    }
  }
}

/** Delete a task file. */
export async function deleteTask(taskListId: string, taskId: string): Promise<boolean> {
  try {
    await unlink(getTaskPath(taskListId, taskId))
    return true
  } catch { return false }
}

/** Claim the next available unblocked task. */
export async function claimNextAvailableTask(
  taskListId: string, agentName: string,
): Promise<TeamTask | null> {
  const allTasks = await listTasks(taskListId)
  for (const task of allTasks) {
    if (task.status !== 'pending') continue
    if (task.owner && task.owner !== agentName) continue

    const blocked = task.dependencies.some(depId => {
      const dep = allTasks.find(t => t.id === depId)
      return dep && dep.status !== 'completed'
    })
    if (blocked) continue

    const claimed = await updateTask(taskListId, task.id, t => {
      if (t.status !== 'pending') return null
      return { ...t, status: 'in_progress', owner: agentName, startedAt: now() }
    })
    if (claimed) return claimed
  }
  return null
}

/** Complete a task with result text. */
export async function completeTask(
  taskListId: string, taskId: string, agentName: string, result?: string,
): Promise<TeamTask | null> {
  return updateTask(taskListId, taskId, t => {
    if (t.owner !== agentName) return t
    return { ...t, status: 'completed', completedAt: now(), result: result ?? t.result }
  })
}

/** Unassign all in-progress tasks for an agent (agent left/disconnected). */
export async function unassignTasksForAgent(
  taskListId: string, agentName: string, reason?: string,
): Promise<void> {
  const allTasks = await listTasks(taskListId)
  for (const task of allTasks) {
    if (task.owner === agentName && task.status === 'in_progress') {
      await updateTask(taskListId, task.id, t => ({
        ...t, status: 'pending', owner: undefined,
        metadata: { ...t.metadata, unassignedAt: now(), unassignedReason: reason ?? 'agent left' },
      }))
    }
  }
}

/** Check if a task has uncompleted dependencies. */
export async function isTaskBlocked(taskListId: string, task: TeamTask): Promise<boolean> {
  if (task.dependencies.length === 0) return false
  const allTasks = await listTasks(taskListId)
  return task.dependencies.some(depId => {
    const dep = allTasks.find(t => t.id === depId)
    return dep && dep.status !== 'completed'
  })
}
