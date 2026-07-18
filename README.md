# pi-rngit-work-document-skill

A [Pi](https://pi.dev) skill (also usable as a plain Node library) for creating
and updating **rngit work documents** over the Reticulum mesh — without the
interactive editor that the `rngit work` CLI requires.

It speaks the exact same `/mgmt/work` request/response protocol as the Python
`rngit work` tooling (see `RNS/Utilities/rngit/server.py`).
Built on [reticulum-js](https://www.npmjs.com/package/reticulum-js).

## What it does

| Operation | Permission needed | Notes |
|---|---|---|
| `list` | read | active (default) / completed / proposed / all |
| `view` | read | document body + update history |
| `create` | write + interact | lands in `active`, signed by your identity |
| `propose` | propose | lands in `proposed` |
| `edit` | write + interact | only the original author |
| `update` | interact | adds a signed update (comment) |
| `complete` | write + interact | moves a doc to `completed` |
| `activate` | write + interact | reactivates a doc into `active` |

## Install as a Pi skill

```bash
pi install npm:pi-rngit-work-document-skill
# or from a local checkout:
pi install ./packages/pi-rngit-work-document-skill
```

## Configuration

The client connects to a local `rnsd` by default and needs to know which rngit
node/repository to talk to.

### Target discovery

The target `rns://<hash>/<group>/<repo>` is resolved automatically, in order:

1. **Auto-discovery** from project files in the current directory:
   - a `rns://` git remote in `.git/config` (set by `git clone rns://...`), then
   - a `package.json` field (`rngit`, `rngit.url`, `reticulum.rngit`, or an
     `rns://` `repository`/`repository.url`), then
   - the first `rns://` URL in `AGENTS.md`, `README.md`, or `CONTRIBUTING.md`.
2. The `RNGIT_URL` / `RNGIT_TARGET` env var, which overrides discovery.

### Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `RNGIT_TARGET_HASH` + `RNGIT_GROUP` + `RNGIT_REPO` | alternative to `RNGIT_URL` | — |
| `RNS_HOST` / `RNS_PORT` | local rnsd TCP interface | `127.0.0.1:42424` |
| `RNGIT_IDENTITY` | path to the client identity key | `~/.pi-rngit-work/identity.key` |
| `RNGIT_PATH_TIMEOUT_MS` | time to learn the remote identity | `30000` |
| `RNGIT_REQUEST_TIMEOUT_MS` | per-request response timeout | `300000` |

### Bootstrapping permissions

Pi keeps its **own** identity (separate from the human's `rngit` client
identity), so the node admin can grant different permissions to humans and
machines. The identity key is generated on first use; print its hash (no network)
and hand it to the admin:

```bash
node skills/rngit-work/scripts/work.js identity
```

The admin then grants that hash permissions on the rngit server, e.g. in
`~/.rngit/config`:

```ini
[access]
public = r:all, w:<pi-hash>, i:<pi-hash>
```

…or per repository in a `<repo>.allowed` file. Flags: `r`=read, `w`=write,
`i`=interact, `p`=propose, `adm`=admin. `create`/`edit`/`update` need `w`+`i`;
`propose` needs `p`; `list`/`view` need `r`.

## CLI usage

```bash
work.js list [--scope active|completed|proposed|all]
work.js view <id> [--scope ...]
work.js create <title...> --file <path|-> [--propose]
work.js edit <id> --file <path|-> [--title <t>] [--scope ...]
work.js update <id> --file <path|-> [--scope ...]
work.js complete <id>
work.js activate <id>
work.js identity                        # print pi's identity hash (no network)
```

Content is read with `--file <path>`, or from stdin via `--file -`. Add `--json`
for structured output. Flags `--url`, `--host`, `--port`, `--identity` override
the environment for a single run.

```bash
echo "# Heading\nBody text" | node scripts/work.js create "My first doc" --file -
node scripts/work.js list --scope all
```

## As a library

```js
import { WorkClient, loadConfig } from "pi-rngit-work-document-skill";

const client = new WorkClient(loadConfig());
await client.connect();

const created = await client.create("Plan something", "# Plan\nLet's …");
console.log(`Created #${created.id}`);

await client.update(created.id, "Update: started on this.");
console.log(await client.view(created.id));

await client.close();
```

## Protocol notes

- **Destination aspect:** `git.repositories`; **request path:** `/mgmt/work`.
- Requests are msgpack **maps** keyed by the integer `0` (`IDX_REPOSITORY`) plus
  string fields. A plain JS object would coerce key `0` to `"0"` and be rejected,
  so the client builds payloads as a `Map`.
- Responses are a status byte (`0` = OK) followed by a msgpack payload.
- `create`/`propose`/`edit` include a 64-byte Ed25519 signature over the content.

## License

EUPL-1.2
