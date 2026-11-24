# Skills Manager

A small web app for managing agent skills and agent instruction files on this server.
It reads skill folders, edits `SKILL.md` files and runs the `skills` CLI (vercel-labs/skills)
to install, update and remove skills.

## At a glance

- Settings for this server are in `.env` (git-ignored). Read it first: it has the live URL
  (`SKILLS_MANAGER_PUBLIC_URL`), the port, the allowed host names, the production checkout and
  the unit name. `.env.example` lists every setting with its default. Never commit `.env`, and
  never put server names, paths or tokens in the code: add a setting instead.
- Server: Bun + Hono on `HOST:PORT` (default `127.0.0.1:3530`). It serves the built UI and
  `/api` on that one port. Access control comes from the network in front of it (for example a
  tailnet through Tailscale Serve); there is no login.
- Service: systemd user unit `SKILLS_MANAGER_UNIT` (default `skills-manager`).
  Status: `systemctl --user status skills-manager`. Logs: `journalctl --user -u skills-manager -f`.
- Repo: `bwhtech/skills-manager` (private).
- Production runs from a separate worktree, `SKILLS_MANAGER_LIVE_DIR` (default `<repo>-live`).
  To ship, commit, then run `scripts/deploy.sh` (see Production).
- Dev: `bun run dev` serves the UI on `SKILLS_MANAGER_DEV_PORT` (default 5530). It sends `/api`
  to `PORT`, which is the live server unless you stop it and run `bun run dev:server`.
- Checks: `bun run typecheck && bun run lint && bun test server`.
- App state: `~/.config/skills-manager/` (`state.json`, removal journals in `removals/`).

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

- `bun run dev:server`: API on `HOST:PORT`, with watch.
- `bun run dev`: Vite on `127.0.0.1:SKILLS_MANAGER_DEV_PORT`, proxies `/api` to `PORT`.
- `bun run typecheck`, `bun run lint`, `bun test server`.
- `bun run build`, then `bun server/index.ts` serves `dist/` and the API on one port.

## Settings

Bun loads `.env` from the working directory; Vite and `scripts/deploy.sh` read it too.

- `PORT`, `HOST`: where the server listens (default `127.0.0.1:3530`).
- `SKILLS_MANAGER_DEV_PORT`: Vite dev server port (default 5530).
- `SKILLS_MANAGER_ALLOWED_HOSTS`: host names the API answers to (see Rules). Default: none.
- `SKILLS_MANAGER_FILE_ROOTS`: folders besides HOME that the file viewer may show. Default: none.
- `SKILLS_MANAGER_SCAN_SKIP`: folders the project scan never enters. Default: none.
- `GITHUB_TOKEN`: token for the skills CLI and update previews. Unset: `gh auth token`.
- `SKILLS_MANAGER_LIVE_DIR`, `SKILLS_MANAGER_UNIT`, `SKILLS_MANAGER_PUBLIC_URL`: for deploys.
- Also `SKILLS_BIN`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `SKILLS_MANAGER_PREVIEW_DIR`.

## Production

- systemd user unit `skills-manager` (`~/.config/systemd/user/skills-manager.service`), with
  `WorkingDirectory` set to the production checkout.
- Production runs from its own checkout, `SKILLS_MANAGER_LIVE_DIR` (a detached git worktree),
  never from this development checkout. Deploy a committed revision with `scripts/deploy.sh [rev]`
  (default `main`): it checks out the revision, links `.env` from this checkout into it, builds
  into `dist.next`, swaps it in, and restarts the unit. Local `bun run build` here only affects
  this checkout. A change to `.env` takes effect at the next restart of the unit.
- App state (pinned projects, scan cache): `~/.config/skills-manager/state.json`.

## Agreed scope (v1)

- Browse skills of every agent that the skills CLI supports, with an agent filter
  (default Claude Code). Show each skill folder once (deduplicate by real path) and list the
  agents that see it.
- Origin badge per skill: `npx`, `manual`, `plugin`, `synced`, `system`.
  Only `npx` and `manual` skills are editable.
- In editable skills, every Markdown file (`.md`, any case) in the skill folder is editable:
  `SKILL.md`, and others through `PUT /api/skills/:id/file`. Other file types are viewable,
  read-only. The frontmatter check runs on `SKILL.md` only.
- Editor: CodeMirror 6 with Markdown + YAML frontmatter + fenced code highlighting,
  Edit / Preview / Split toggle. Frontmatter check: `name` and `description` present,
  `name` matches the folder name.
- Explicit save (button and Cmd/Ctrl+S), dirty dot, unsaved-changes guard, conflict warning
  when the file changed on disk.
- npx skills show a fixed warning on every editable file: "Update overwrites local edits."
  No backup, no diff.
- Instruction files: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` at user and project level.
  Create missing files. A symlinked file never opens in an editor: selecting it opens its target
  (in the target's scope), and rows show "Synced → …" and "Also read as …".
  "Sync another file to this…" turns other instruction files into symlinks to a regular file
  (preview with diff, backup to `<path>.bak`); "Stop syncing…" turns a link back into a file.
- Projects: cached scan of `~` (depth 4) plus pinned projects; Rescan button.
- Updates: `skills check` on boot and on Refresh, with env `GITHUB_TOKEN` or `gh auth token`.
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
- Never write outside paths the server discovered itself (existing Markdown files listed in
  the folder of an editable skill, whose real path stays inside that folder, and known
  instruction file paths). One exception: the file viewer (`PUT /api/file`) saves an existing
  Markdown file (`.md`) under HOME or a `SKILLS_MANAGER_FILE_ROOTS` folder that a document links
  to, with the same secret deny list and checks as `GET /api/file`. It never creates a file, and
  other file types stay read-only.
- Saves write the real path they validated (`saveTextFile` with `resolved: true`), run the
  checks again under the save lock, and check after the rename that the path still resolves to
  itself. Bun has no `openat`, so a same-user race that swaps a parent dir for a symlink stays
  possible; the post-rename check logs it loudly. Same accepted limit as instruction sync.
- Of a save's 409s, only `conflict` opens the conflict dialog (Overwrite = forced save).
  `moved` and `now_linked` keep the draft and show a notice, with no Overwrite.
- Mutating requests need header `X-Skills-Manager: 1` and a same-origin `Origin`.
- Every `/api` request must name an allowed host, against DNS rebinding (403 `bad_host`).
  `localhost`, `127.0.0.1` and `[::1]` are always allowed, on any port. The other allowed host
  names come from env `SKILLS_MANAGER_ALLOWED_HOSTS` (comma-separated host names, no ports).
  Default: none (loopback only). Set it in `.env`.
  The server checks `Host`, and also `X-Forwarded-Host` when the TCP peer is loopback
  (Tailscale Serve connects from 127.0.0.1, keeps `Host` and sets `X-Forwarded-Host` to the
  same name). It ignores `X-Forwarded-Host` from other peers.
- `/api` requests with `Sec-Fetch-Site: cross-site` get 403.
