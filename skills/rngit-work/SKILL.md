---
name: rngit-work
description: Create and update rngit work documents over the Reticulum mesh. Use when asked to list, view, create, edit, add an update to, complete, or activate a work document on an rngit node (e.g. the project's work document board). Runs the bundled work.js client built on reticulum-js — no interactive editor needed.
---

# rngit work documents

Manage work documents on an rngit repository node directly from a shell, without
the interactive `$EDITOR` flow that `rngit work` requires.

This skill ships a Node CLI at `scripts/work.js` that speaks the same `/mgmt/work`
protocol as `rngit work`, so documents are fully interchangeable.

## Setup

This skill needs two things: the **target** rngit repository and pi's own
**identity** (kept separate from the human's rngit identity, so human and
machine can have different permissions).

### 1. Configure the target (usually automatic)

The target `rns://<hash>/<group>/<repo>` is resolved automatically, in this
order — you rarely need to set anything:

1. **Auto-discovery** from project files in the current directory:
   - a `rns://` git remote in `.git/config` (set by `git clone rns://...`), then
   - a `package.json` field (`rngit`, `rngit.url`, `reticulum.rngit`, or an
     `rns://` `repository`/`repository.url`), then
   - the first `rns://` URL in `AGENTS.md`, `README.md`, or `CONTRIBUTING.md`.
2. The `RNGIT_URL` env var, which overrides discovery.

If discovery fails, ask the user for the URL (it's the same one `rngit work`
uses) and set `RNGIT_URL`, or pass `--url rns://...` per run. Other env vars:

| Variable | Meaning | Default |
|---|---|---|
| `RNS_HOST` / `RNS_PORT` | local rnsd TCP interface | `127.0.0.1:42424` |
| `RNGIT_IDENTITY` | path to pi's identity key | `~/.pi-rngit-work/identity.key` |

### 2. Bootstrap pi's identity (needs the user, once)

Pi uses its own identity, so the rngit node admin must grant it permissions
**before create/edit/update/propose will work** (read-only `list`/`view` just
needs `read`). This requires manual user intervention — you cannot grant it
yourself.

Print pi's identity hash (this generates the key on first run, no network
needed):

```bash
node scripts/work.js identity
```

Then ask the user (node admin) to grant that hash permissions on the rngit
server and (re)start rngit, e.g. in the server's `~/.rngit/config`:

```ini
[access]
public = r:all, w:<pi-hash>, i:<pi-hash>
```

…or per repository, in a `<repo>.allowed` file next to the repo:

```
r:all
w:<pi-hash>
i:<pi-hash>
```

Permission flags: `r`=read, `w`=write, `i`=interact, `p`=propose, `adm`=admin.
`create`/`edit`/`update` need `w`+`i`; `propose` needs `p`; `list`/`view` need
`r`. Until permissions are granted, write operations will fail with exit code 2
("Remote rejected (1): Not allowed").

## Operations

All commands are run by invoking this skill's `scripts/work.js` from your
project's root directory (your normal working directory). Set `SKILL` to the
absolute path of this skill's `scripts/work.js`. The target URL is
auto-discovered from the project; `--url` overrides it. Content for
`create`/`edit`/`update` is read with `--file <path>` or piped via stdin
(`--file -`).

```bash
SKILL=<this skill directory>/scripts/work.js

# List documents (active by default; --scope all|completed|proposed)
node "$SKILL" list
node "$SKILL" list --scope all

# View a document (body + update history)
node "$SKILL" view 8

# Create a new document: title as positional args, body from a file or stdin
node "$SKILL" create "Interface configuration schemas" --file /tmp/doc.md
echo "Short proposal body" | node "$SKILL" create "Quick idea" --file -

# Propose (lands in the `proposed` scope instead of `active`)
node "$SKILL" create "Experimental feature" --propose --file /tmp/feat.md

# Edit an existing document (only the original author can edit)
node "$SKILL" edit 8 --file /tmp/revised.md
node "$SKILL" edit 8 --file /tmp/revised.md --title "New title"

# Add an update (comment) to a document
node "$SKILL" update 8 --file /tmp/update.md

# Move a document through its lifecycle
node "$SKILL" complete 8
node "$SKILL" activate 8
```

Append `--json` to any command for structured output (useful when you need to
parse the result rather than show it to the user).

## Workflow notes

- **Author the content as Markdown.** Write it to a temp file, then pass
  `--file`. Keep documents under 256 KiB.
- **Only the author may `edit`.** To correct someone else's document, use
  `update` (a signed comment) or ask the author.
- **Signatures:** `create`, `propose`, and `edit` are signed by pi's identity,
  so authorship is attributable on the node.
- **Always show the user** the resulting document id / scope and the text you
  submitted, and do not claim success unless the CLI exited 0.

## Exit codes

- `0` — success
- `1` — local/config error (bad URL, missing env, empty content, transport)
- `2` — the rngit node rejected the request (permissions, not found, invalid);
  the message explains why

## Troubleshooting

- *"Could not learn an identity"* — the node isn't reachable or hasn't
  announced. Check `RNS_HOST`/`RNS_PORT` point at a working rnsd with a path to
  the node.
- *Remote rejected (1): "Not identified"* — shouldn't happen (the client
  identifies automatically); indicates a link-level issue.
- *Remote rejected (1): "Not allowed"* — pi's identity lacks the needed
  permission; ask the node admin.
