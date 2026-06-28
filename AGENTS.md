<!-- PID-Agent-Teams-Tmux AGENTS.md -->

This project is a Pi extension that replicates Claude Code's agent team functionality
using tmux panes. It consists of:

## Architecture

Two roles in one extension:

- **Leader** (no env var): Runs in the main Pi session. Creates teams, spawns teammates
  in tmux panes, manages shared task lists, and coordinates work.
- **Worker** (`PI_TEAMS_WORKER=1`): Runs in a tmux pane as a spawned teammate.
  Polls its mailbox for instructions, auto-claims tasks, and sends idle notifications.

## Commands

```
/team spawn <name>    — Spawn a teammate in a tmux pane
/team list            — List teammates and status
/team task add ...    — Create a task
/team task list       — List all tasks
/team dm <name> <msg> — Send direct message
/team broadcast <msg> — Broadcast to all
/team shutdown [name] — Graceful shutdown
/team kill <name>     — Force kill
/team done            — End team session (stop all)
/team cleanup         — Delete team artifacts
/tw                   — Open widget panel
/swarm <task>         — Auto-swarm on a task
```

## Tools (model-callable)

- team_create, spawn_teammate, task_create, task_list, task_get, task_update
- send_message, broadcast_message, team_shutdown, team_kill

## Storage

Team state is stored under `~/.pi/agent/teams/<teamId>/`:
- config.json — Team configuration and member list
- tasks/<taskListId>/<id>.json — Shared task files
- mailboxes/team/inboxes/<agent>.json — Per-agent inbox files
