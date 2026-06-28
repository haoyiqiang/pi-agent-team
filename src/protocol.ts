/**
 * protocol.ts — Shared message/event types for agent team communication.
 *
 * Defines the on-wire formats for mailbox messages between leader and workers,
 * matching Claude Code's protocol conventions.
 */

/** Namespace for team-level mailbox messages (DM, idle, shutdown) */
export const TEAM_MAILBOX_NS = 'team'

/** Namespace for task-level mailbox messages (task_assignment) */
export const TASK_MAILBOX_NS = 'tasks'

/** Time-to-live for idle mailbox keep-alive (ms) */
export const IDLE_TTL_MS = 30_000

/** Shutdown grace period after SIGTERM before SIGKILL (ms) */
export const SHUTDOWN_GRACE_MS = 5_000

/** Timeout for shutdown handshake (ms) */
export const SHUTDOWN_HANDSHAKE_TIMEOUT_MS = 10_000

// ─── Mailbox Message ───────────────────────────────────────────

export type MailMessage = {
  id: string
  from: string
  text: string
  timestamp: string
  read: boolean
  urgent?: boolean
  summary?: string
  color?: string
}

// ─── Protocol Message Types ────────────────────────────────────

export type ShutdownRequest = {
  type: 'shutdown_request'
  requestId: string
  from: string
  reason?: string
  timestamp: string
}

export type ShutdownApproved = {
  type: 'shutdown_approved'
  requestId: string
  from: string
  timestamp: string
}

export type ShutdownRejected = {
  type: 'shutdown_rejected'
  requestId: string
  from: string
  reason?: string
  timestamp: string
}

export type IdleNotification = {
  type: 'idle_notification'
  from: string
  timestamp: string
  completedTaskId?: string
  completedStatus?: 'completed' | 'failed'
  failureReason?: string
}

export type TaskAssignment = {
  type: 'task_assignment'
  taskId: string
  from: string
  subject: string
  timestamp: string
}

export type SetSessionName = {
  type: 'set_session_name'
  name: string
  from: string
  timestamp: string
}

export type PeerDmSent = {
  type: 'peer_dm_sent'
  from: string
  to: string
  summary: string
  urgent?: boolean
  timestamp: string
}

export type PlanApprovalRequest = {
  type: 'plan_approval_request'
  requestId: string
  from: string
  plan: string
  taskId?: string
  timestamp: string
}

export type PlanApproved = {
  type: 'plan_approved'
  requestId: string
  from: string
  taskId?: string
  timestamp: string
}

export type PlanRejected = {
  type: 'plan_rejected'
  requestId: string
  from: string
  feedback?: string
  taskId?: string
  timestamp: string
}

export type PermissionRequest = {
  type: 'permission_request'
  requestId: string
  from: string
  toolName: string
  args: string
  timestamp: string
}

export type PermissionResponse = {
  type: 'permission_response'
  requestId: string
  from: string
  approved: boolean
  reason?: string
  timestamp: string
}

export type SandboxPermissionRequest = {
  type: 'sandbox_permission_request'
  requestId: string
  from: string
  operation: string
  details: string
  timestamp: string
}

export type SandboxPermissionResponse = {
  type: 'sandbox_permission_response'
  requestId: string
  from: string
  approved: boolean
  timestamp: string
}

export type ModeSetRequest = {
  type: 'mode_set_request'
  from: string
  mode: string
  timestamp: string
}

export type ProtocolMessage =
  | ShutdownRequest
  | ShutdownApproved
  | ShutdownRejected
  | IdleNotification
  | TaskAssignment
  | SetSessionName
  | PeerDmSent
  | PlanApprovalRequest
  | PlanApproved
  | PlanRejected
  | PermissionRequest
  | PermissionResponse
  | SandboxPermissionRequest
  | SandboxPermissionResponse
  | ModeSetRequest

export const PROTOCOL_MESSAGE_TYPES = [
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
] as const

// ─── Parsers ───────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

export function parseProtocolMessage<T extends ProtocolMessage>(
  text: string,
  typeGuard: (v: unknown) => v is T,
): T | null {
  const obj = safeJsonParse(text)
  if (!isRecord(obj)) return null
  return typeGuard(obj) ? obj : null
}

export function isShutdownRequest(v: unknown): v is ShutdownRequest {
  return isRecord(v) && v.type === 'shutdown_request' && typeof v.requestId === 'string'
}

export function isShutdownApproved(v: unknown): v is ShutdownApproved {
  return isRecord(v) && v.type === 'shutdown_approved' && typeof v.requestId === 'string'
}

export function isShutdownRejected(v: unknown): v is ShutdownRejected {
  return isRecord(v) && v.type === 'shutdown_rejected' && typeof v.requestId === 'string'
}

export function isIdleNotification(v: unknown): v is IdleNotification {
  return isRecord(v) && v.type === 'idle_notification' && typeof v.from === 'string'
}

export function isTaskAssignment(v: unknown): v is TaskAssignment {
  return isRecord(v) && v.type === 'task_assignment' && typeof v.taskId === 'string'
}

export function isSetSessionName(v: unknown): v is SetSessionName {
  return isRecord(v) && v.type === 'set_session_name' && typeof v.name === 'string'
}

export function isPlanApprovalRequest(v: unknown): v is PlanApprovalRequest {
  return isRecord(v) && v.type === 'plan_approval_request' && typeof v.requestId === 'string'
}

export function isPlanApproved(v: unknown): v is PlanApproved {
  return isRecord(v) && v.type === 'plan_approved' && typeof v.requestId === 'string'
}

export function isPlanRejected(v: unknown): v is PlanRejected {
  return isRecord(v) && v.type === 'plan_rejected' && typeof v.requestId === 'string'
}

export function isPermissionRequest(v: unknown): v is PermissionRequest {
  return isRecord(v) && v.type === 'permission_request' && typeof v.requestId === 'string'
}

export function isPermissionResponse(v: unknown): v is PermissionResponse {
  return isRecord(v) && v.type === 'permission_response' && typeof v.requestId === 'string'
}

export function isSandboxPermissionRequest(v: unknown): v is SandboxPermissionRequest {
  return isRecord(v) && v.type === 'sandbox_permission_request' && typeof v.requestId === 'string'
}

export function isSandboxPermissionResponse(v: unknown): v is SandboxPermissionResponse {
  return isRecord(v) && v.type === 'sandbox_permission_response' && typeof v.requestId === 'string'
}

export function isModeSetRequest(v: unknown): v is ModeSetRequest {
  return isRecord(v) && v.type === 'mode_set_request' && typeof v.mode === 'string'
}
