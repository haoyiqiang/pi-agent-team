/**
 * pi-agent-teams-tmux — Pi extension replicating Claude Code agent teams
 * using tmux panes for teammate isolation.
 *
 * Two-role architecture:
 *   - Leader: creates team, spawns tmux pane teammates, manages tasks
 *   - Worker: polls mailbox for instructions, auto-claims tasks
 *
 * Role is determined by PI_TEAMS_WORKER=1 env var.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { runLeader } from './src/leader.js'
import { runWorker } from './src/worker.js'

const IS_WORKER = process.env.PI_TEAMS_WORKER === '1'

export default function (pi: ExtensionAPI): void {
  if (IS_WORKER) {
    runWorker(pi)
  } else {
    runLeader(pi)
  }
}
