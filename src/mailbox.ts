/**
 * mailbox.ts — File-based mailbox (1:1 with Claude Code's teammateMailbox.ts)
 *
 * Claude Code: ~/.claude/teams/<teamName>/inboxes/<agent>.json
 * Pi:          <agentDir>/teams/<teamId>/inboxes/<agent>.json
 *
 * File locking via proper-lockfile with retry backoff prevents
 * concurrent read-then-write races when multiple agents write simultaneously.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as lockfile from 'proper-lockfile'
import type { MailMessage } from './protocol.js'
import { getInboxPath } from './paths.js'

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function readInboxFile(path: string): Promise<MailMessage[]> {
  try {
    const content = await readFile(path, 'utf-8')
    return JSON.parse(content) as MailMessage[]
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
}

async function writeInboxFile(path: string, messages: MailMessage[]): Promise<void> {
  await writeFile(path, JSON.stringify(messages, null, 2), 'utf-8')
}

async function lockAndUpdate<T>(
  filePath: string,
  fn: (messages: MailMessage[]) => T,
): Promise<T> {
  try {
    return await lockfile.lock(filePath, LOCK_OPTIONS, async (release) => {
      try {
        const messages = await readInboxFile(filePath)
        const result = fn(messages)
        await writeInboxFile(filePath, messages)
        return result
      } finally {
        release()
      }
    })
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      await writeInboxFile(filePath, [])
      return lockAndUpdate(filePath, fn)
    }
    throw err
  }
}

/** Write a message to an agent's inbox. */
export async function writeToMailbox(
  teamDir: string,
  agentName: string,
  msg: Omit<MailMessage, 'id' | 'read'>,
): Promise<void> {
  const path = getInboxPath(teamDir, agentName)
  await ensureDir(dirname(path))
  await lockAndUpdate(path, (messages) => {
    messages.push({ ...msg, id: randomUUID(), read: false })
  })
}

/** Read all messages from an inbox. */
export async function readMailbox(teamDir: string, agentName: string): Promise<MailMessage[]> {
  return readInboxFile(getInboxPath(teamDir, agentName))
}

/** Pop (read and remove) all unread messages from an inbox. */
export async function popUnreadMessages(teamDir: string, agentName: string): Promise<MailMessage[]> {
  const path = getInboxPath(teamDir, agentName)
  return lockAndUpdate(path, (messages) => {
    const unread = messages.filter(m => !m.read)
    if (unread.length === 0) return []
    // Keep read messages, return unread
    messages.length = 0
    messages.push(...messages.filter(m => m.read))
    return unread
  })
}

/** Mark a message as read by its index. */
export async function markAsReadByIndex(teamDir: string, agentName: string, index: number): Promise<void> {
  const path = getInboxPath(teamDir, agentName)
  await lockAndUpdate(path, (messages) => {
    if (index >= 0 && index < messages.length && !messages[index]!.read) {
      messages[index] = { ...messages[index]!, read: true }
    }
  })
}

/** Mark messages as read using a predicate. */
export async function markAsReadByPredicate(
  teamDir: string, agentName: string, predicate: (msg: MailMessage) => boolean,
): Promise<number> {
  const path = getInboxPath(teamDir, agentName)
  return lockAndUpdate(path, (messages) => {
    let count = 0
    for (const m of messages) {
      if (!m.read && predicate(m)) { m.read = true; count++ }
    }
    return count
  })
}

/** Check if message text is a structured protocol message (not raw LLM content). */
export function isStructuredProtocolMessage(text: string): boolean {
  try {
    const obj = JSON.parse(text)
    if (typeof obj !== 'object' || obj === null) return false
    const type = (obj as Record<string, unknown>).type
    if (typeof type !== 'string') return false
    return [
      'shutdown_request', 'shutdown_approved', 'shutdown_rejected',
      'idle_notification', 'task_assignment', 'set_session_name', 'peer_dm_sent',
      'plan_approval_request', 'plan_approved', 'plan_rejected',
      'permission_request', 'permission_response',
      'sandbox_permission_request', 'sandbox_permission_response',
      'mode_set_request',
    ].includes(type)
  } catch { return false }
}
