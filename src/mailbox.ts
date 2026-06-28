/**
 * mailbox.ts — File-based mailbox with proper-lockfile (1:1 with Claude Code's teammateMailbox.ts)
 *
 * File locking via proper-lockfile with retry backoff prevents concurrent
 * read-then-write races when multiple agents write simultaneously.
 * Each agent has an inbox file as JSON array.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as lockfile from 'proper-lockfile'
import type { MailMessage } from './protocol.js'
import { getMailboxDir, getMailboxPath } from './paths.js'

// Lock options: retry with backoff so concurrent callers wait for the lock
// instead of failing immediately (same as Claude Code)
const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

// ─── Internal read/write with locking ──────────────────────────

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
  // proper-lockfile uses fs.realpath internally, so the file must exist
  // Ensure the parent directory exists (file may not yet exist)
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
    // If file doesn't exist yet, create it and retry
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // Create empty file first, then the lock will find it
      await writeInboxFile(filePath, [])
      return lockAndUpdate(filePath, fn)
    }
    throw err
  }
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Write a message to an agent's inbox.
 * Thread-safe via proper-lockfile (same as Claude Code).
 */
export async function writeToMailbox(
  teamDir: string,
  namespace: string,
  recipient: string,
  msg: Omit<MailMessage, 'id' | 'read'>,
): Promise<void> {
  const dir = getMailboxDir(teamDir, namespace)
  await ensureDir(dir)
  const path = getMailboxPath(teamDir, namespace, recipient)

  await lockAndUpdate(path, (messages) => {
    messages.push({
      ...msg,
      id: randomUUID(),
      read: false,
    })
  })
}

/**
 * Read all messages from an inbox.
 */
export async function readMailbox(
  teamDir: string,
  namespace: string,
  agentName: string,
): Promise<MailMessage[]> {
  const path = getMailboxPath(teamDir, namespace, agentName)
  return readInboxFile(path)
}

/**
 * Pop (read and remove) all unread messages from an inbox.
 */
export async function popUnreadMessages(
  teamDir: string,
  namespace: string,
  agentName: string,
): Promise<MailMessage[]> {
  const path = getMailboxPath(teamDir, namespace, agentName)
  return lockAndUpdate(path, (messages) => {
    const unread = messages.filter(m => !m.read)
    if (unread.length === 0) return []
    const remaining = messages.filter(m => m.read)
    // Claude Code: write back remaining, return unread
    messages.length = 0
    messages.push(...remaining)
    return unread
  })
}

/**
 * Mark a single message as read by its index in the array.
 */
export async function markAsReadByIndex(
  teamDir: string,
  namespace: string,
  agentName: string,
  index: number,
): Promise<void> {
  const path = getMailboxPath(teamDir, namespace, agentName)
  await lockAndUpdate(path, (messages) => {
    if (index >= 0 && index < messages.length && !messages[index]!.read) {
      messages[index] = { ...messages[index]!, read: true }
    }
  })
}

/**
 * Mark messages as read using a predicate function.
 */
export async function markAsReadByPredicate(
  teamDir: string,
  namespace: string,
  agentName: string,
  predicate: (msg: MailMessage) => boolean,
): Promise<number> {
  const path = getMailboxPath(teamDir, namespace, agentName)
  return lockAndUpdate(path, (messages) => {
    let count = 0
    for (const m of messages) {
      if (!m.read && predicate(m)) {
        m.read = true
        count++
      }
    }
    return count
  })
}

/**
 * Check if a message text contains a structured protocol message.
 * Prevents protocol messages from being consumed as raw LLM context
 * (1:1 with Claude Code's isStructuredProtocolMessage).
 */
export function isStructuredProtocolMessage(text: string): boolean {
  try {
    const obj = JSON.parse(text)
    if (typeof obj !== 'object' || obj === null) return false
    const type = (obj as Record<string, unknown>).type
    if (typeof type !== 'string') return false
    return [
      'shutdown_request',
      'shutdown_approved',
      'shutdown_rejected',
      'idle_notification',
      'task_assignment',
      'set_session_name',
      'peer_dm_sent',
      'plan_approval_request',
      'plan_approved',
      'plan_rejected',
      'permission_request',
      'permission_response',
      'sandbox_permission_request',
      'sandbox_permission_response',
      'mode_set_request',
    ].includes(type)
  } catch {
    return false
  }
}
