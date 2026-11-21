# Skills Manager

A small web app for managing agent skills and agent instruction files on this server.
It reads skill folders, edits `SKILL.md` files and runs the `skills` CLI (vercel-labs/skills)
to install, update and remove skills.

## Stack

- Backend: Hono on Bun, in `server/`. Entry: `server/index.ts`.
- Frontend: Vite + React 19 + shadcn (preset `b6GgJ8ttZ`: style `base-luma`, Base UI primitives,
  Hugeicons, Geist Mono), in `src/`. Data fetching with TanStack Query.
- Shared API contract: `shared/api.ts`. Import it as `@shared/api` in `src/` and with a
  relative path in `server/`. It is the single source of truth for routes and types.
- Package manager: bun. Do not add `package-lock.json`.
- The `skills` CLI is a pinned dependency (`node_modules/.bin/skills`). The server runs it from
  there, not through `npx`, so runs start fast. Override with env `SKILLS_BIN`.

## Commands

- `bun run dev:server`: API on `127.0.0.1:3530`, with watch.
- `bun run dev`: Vite on `127.0.0.1:5530`, proxies `/api` to 3530.
- `bun run typecheck`, `bun run lint`, `bun test server`.
- `bun run build`, then `bun server/index.ts` serves `dist/` and the API on one port.

## Production

- systemd user unit `skills-manager` (`~/.config/systemd/user/skills-manager.service`).
- Production runs from its own checkout, `/mnt/data/skills-manager-live` (a detached git worktree),
  never from this development checkout. Deploy a committed revision with `scripts/deploy.sh [rev]`
  (default `main`): it checks out the revision, builds into `dist.next`, swaps it in, and restarts
  the unit. Local `bun run build` here only affects this checkout.
- Listens on `127.0.0.1:3530`. Tailnet only: `https://hussain-coding.tail5c9b7d.ts.net:8466`
  through Tailscale Serve. No login: the tailnet is the access control.
- App state (pinned projects, scan cache): `~/.config/skills-manager/state.json`.

## Agreed scope (v1)

- Browse skills of every agent that the skills CLI supports, with an agent filter
  (default Claude Code). Show each skill folder once (deduplicate by real path) and list the
  agents that see it.
- Origin badge per skill: `npx`, `manual`, `plugin`, `synced`, `system`.
  Only `npx` and `manual` skills are editable.
- Only `SKILL.md` is editable. Other files in the skill folder are viewable, read-only.
- Editor: CodeMirror 6 with Markdown + YAML frontmatter + fenced code highlighting,
  Edit / Preview / Split toggle. Frontmatter check: `name` and `description` present,
  `name` matches the folder name.
- Explicit save (button and Cmd/Ctrl+S), dirty dot, unsaved-changes guard, conflict warning
  when the file changed on disk.
- npx skills show a fixed warning: "Update overwrites local edits." No backup, no diff.
- Instruction files: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` at user and project level.
  Create missing files. Symlinked files open their target and show a "linked" badge.
- Projects: cached scan of `~` (depth 4) plus pinned projects; Rescan button.
- Updates: `skills check` on boot and on Refresh, using `gh auth token` as `GITHUB_TOKEN`.
  Per-skill Update and Update all. CLI output streams to a log drawer.
- Install: search skills.sh, or paste `owner/repo` / URL and list its skills. Pick scope
  (user or one project) and agents (default: `lastSelectedAgents` from the lock file).
- Remove, with confirmation. The CLI removes npx skills. The server deletes a manual skill only
  from a user-level agent skills dir or a project skills dir under a dot folder
  (`.claude/skills`, `.agents/skills`). In other project dirs (`skills/`, `data/skills`), Remove
  is disabled (`SkillSummary.removable`), because those folders are often the project's source.
- Out of scope for v1: subagents, slash commands, rules, creating new skills, copy/move.

## Rules

- Run the skills CLI non-interactively: `-y`, stdin not a TTY, env `DISABLE_TELEMETRY=1`
  and `DO_NOT_TRACK=1`, `NO_COLOR=1`. Use argument arrays (`Bun.spawn([...])`), never a shell string.
- Never write outside paths the server discovered itself (skill `SKILL.md` files of editable
  skills, and known instruction file paths).
- Mutating requests need header `X-Skills-Manager: 1` and a same-origin `Origin`.
