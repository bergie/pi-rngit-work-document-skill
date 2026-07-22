/**
 * @file work-client.js
 *
 * reticulum-js client for the **rngit work-document** protocol.
 *
 * Drives the same `/mgmt/work` request/response protocol as the `rngit work`
 * CLI (see `RNS/Utilities/rngit/server.py` in the Python reference), so
 * documents created or edited here are fully interchangeable with those from
 * the Python tooling.
 *
 * Wire contract (reverse-engineered from the Python reference implementation):
 *
 *  - Destination aspect: `"git.repositories"` (APP_NAME `"git"`, aspect
 *    `"repositories"`).
 *  - Request path: `"/mgmt/work"`.
 *  - Request `data`: a msgpack **map** keyed by the integer `0`
 *    (`IDX_REPOSITORY`, the `"group/repo"` path) plus string keys such as
 *    `operation`, `scope`, `doc_id`, `title`, `content`, `format`, `signature`.
 *    Note: a plain JS object would coerce key `0` to the string `"0"` on the
 *    wire and the Python server would reject the request with "No repository
 *    specified"; we therefore build the payload as a `Map`.
 *  - Response: a msgpack `bin` blob whose first byte is a status code
 *    (`0` = OK; `1` disallowed, `2` invalid, `3` not found, `0xff` remote
 *    failure) and whose tail is a msgpack payload (or a UTF-8 error message).
 *  - `create`, `propose` and `edit` sign the UTF-8 bytes of `content` with the
 *    client's Ed25519 identity and send the 64-byte signature.
 *
 * The client connects to a local `rnsd` over TCP by default, learns the remote
 * node's identity from an announce/path-response, establishes a Link,
 * identifies itself (`LINKIDENTIFY`), then issues requests.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  Destination,
  DestType,
  fromHex,
  Identity,
  MsgPack,
  Reticulum,
  toHex,
} from "reticulum-js";
import { LocalClientInterface } from "reticulum-js/src/interfaces/local_client.js";
import { AutoInterface } from "reticulum-js/src/interfaces/auto.js";
import { TCPClientInterface } from "reticulum-js/src/interfaces/tcp.js";
import { createBz2 } from "./bz2.js";

// --- Protocol constants (mirror the Python `ReticulumGitClient`) -----------

/** Destination aspect for an rngit repository node. */
export const ASPECT = "git.repositories";
/** Request path for work-document operations. */
export const PATH_WORK = "/mgmt/work";
/** msgpack map key for the `"group/repo"` repository path. */
export const IDX_REPOSITORY = 0;

/** Response status codes (first byte of every `/mgmt/work` response). */
export const Status = Object.freeze({
  OK: 0x00,
  DISALLOWED: 0x01,
  INVALID: 0x02,
  NOT_FOUND: 0x03,
  REMOTE_FAIL: 0xff,
});

/** Valid work-document lifecycle scopes. */
export const SCOPES = ["active", "completed", "proposed", "all"];

/**
 * Matches an `rns://<32-hex-hash>/<group>/<repo>` URL anywhere in text. Excludes
 * quotes, backticks, brackets and whitespace so markdown-wrapped URLs (e.g.
 * `` `rns://...` ``) are captured cleanly. Used to discover the rngit target
 * from project files.
 */
export const RNS_URL_RE =
  /rns:\/\/[0-9a-fA-F]{32}\/[^\s"'`)\]>\/]+\/[^\s"'`)\]>\/]+/;

// --- Errors ---------------------------------------------------------------

/**
 * Thrown when a `/mgmt/work` response carries a non-OK status byte.
 * `status` is the raw status code; `message` is the server's text.
 */
export class WorkError extends Error {
  /** @param {number} status - Raw status byte from the server. */
  status;
  constructor(status, message) {
    super(message || statusLabel(status));
    this.name = "WorkError";
    this.status = status;
  }
}

/** Thrown for local configuration problems (bad URL, missing env, ...). */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

// --- Pure helpers ---------------------------------------------------------

/**
 * Parses an `rns://<hash>/<group>/<repo>` remote URL (or the equivalent
 * `<hash>/<group>/<repo>` form) into its components.
 * @param {string} input
 * @returns {{ targetHash: Uint8Array, group: string, repo: string, repoPath: string }}
 */
export function parseRemoteUrl(input) {
  if (!input || typeof input !== "string") {
    throw new ConfigError("No remote URL specified");
  }
  let rest = input;
  if (rest.toLowerCase().startsWith("rns://")) rest = rest.slice("rns://".length);
  const parts = rest.split("/");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new ConfigError(
      `Invalid remote URL: ${input}\nExpected rns://<hash>/<group>/<repo>`,
    );
  }
  const [hashHex, group, repo] = parts;
  const targetHash = toHashBytes(hashHex);
  return { targetHash, group, repo, repoPath: `${group}/${repo}` };
}

/**
 * Coerces a 16-byte destination hash (hex string or `Uint8Array`) into bytes.
 * @param {string|Uint8Array} hash
 * @returns {Uint8Array}
 */
export function toHashBytes(hash) {
  if (hash instanceof Uint8Array) {
    if (hash.length !== 16) {
      throw new ConfigError(`Destination hash must be 16 bytes, got ${hash.length}`);
    }
    return hash;
  }
  if (typeof hash === "string") {
    let bytes;
    try {
      bytes = fromHex(hash.trim());
    } catch {
      throw new ConfigError(`Destination hash must be valid hex, got "${hash}"`);
    }
    if (bytes.length !== 16) {
      throw new ConfigError(
        `Destination hash must be 32 hex chars (16 bytes), got "${hash}"`,
      );
    }
    return bytes;
  }
  throw new ConfigError("Destination hash must be a hex string or Uint8Array");
}

/**
 * Builds the msgpack `data` map for a `/mgmt/work` request.
 *
 * Uses a `Map` so the integer `IDX_REPOSITORY` key stays an integer on the
 * wire (a plain object would emit it as the string `"0"` and the Python server
 * would reject the request).
 *
 * @param {string} repoPath - `"group/repo"` repository path.
 * @param {Record<string, any>} [fields] - Additional string-keyed fields.
 * @returns {Map<number|string, any>}
 */
export function buildRequest(repoPath, fields = {}) {
  const map = new Map();
  map.set(IDX_REPOSITORY, repoPath);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) map.set(key, value);
  }
  return map;
}

/**
 * Decodes a `/mgmt/work` response blob (`status byte || msgpack payload`).
 *
 * @param {Uint8Array} response - The `bin` returned by `Link.request()`.
 * @returns {any} The decoded payload, or `null` for an OK response with no body.
 * @throws {WorkError} when the status byte is not `Status.OK`.
 */
export function parseResponse(response) {
  if (!response) {
    throw new WorkError(Status.REMOTE_FAIL, "Empty response from remote");
  }
  if (!(response instanceof Uint8Array)) {
    throw new WorkError(
      Status.REMOTE_FAIL,
      `Unexpected response type: ${response?.constructor?.name ?? typeof response}`,
    );
  }
  const status = response[0];
  if (status !== Status.OK) {
    const text =
      response.length > 1
        ? new TextDecoder().decode(response.subarray(1))
        : "";
    throw new WorkError(status, text || statusLabel(status));
  }
  if (response.length <= 1) return null;
  return MsgPack.decode(response.subarray(1));
}

/**
 * Returns a human-readable label for a status code.
 * @param {number} status
 * @returns {string}
 */
export function statusLabel(status) {
  switch (status) {
    case Status.OK:
      return "OK";
    case Status.DISALLOWED:
      return "Not allowed";
    case Status.INVALID:
      return "Invalid request";
    case Status.NOT_FOUND:
      return "Not found";
    case Status.REMOTE_FAIL:
      return "Remote error";
    default:
      return `Unknown status ${status}`;
  }
}

/**
 * Formats a `list` response as a readable text table.
 * @param {Record<string, any[]>} result - `{ active: [], completed: [], proposed: [] }`.
 * @returns {string}
 */
export function formatList(result) {
  const out = [];
  const scopes = ["active", "completed", "proposed"];
  let any = false;
  for (const scope of scopes) {
    const docs = Array.isArray(result?.[scope]) ? result[scope] : [];
    if (!docs.length) continue;
    any = true;
    const heading = `${scope[0].toUpperCase()}${scope.slice(1)} documents`;
    out.push(`\n${heading}`, "=".repeat(heading.length), "");
    out.push(
      pad("ID", 5) +
        pad("Title", 32) +
        pad("Author", 18) +
        pad("Created", 18) +
        "Comments",
    );
    out.push("-".repeat(80));
    for (const doc of docs) {
      const created = doc.created
        ? new Date(doc.created * 1000)
            .toISOString()
            .replace("T", " ")
            .slice(0, 16)
        : "unknown";
      out.push(
        pad(String(doc.id ?? "?"), 5) +
          pad(truncate(doc.title ?? "Untitled", 31), 32) +
          pad(truncate(doc.author ?? "", 17), 18) +
          pad(created, 18) +
          String(doc.comments ?? 0),
      );
    }
    out.push("");
  }
  if (!any) out.push("No work documents found.");
  return out.join("\n");
}

/**
 * Formats a `view` response (a single document with comments) as readable text.
 * @param {any} doc
 * @returns {string}
 */
export function formatView(doc) {
  const meta = doc?.meta ?? {};
  const heading = `${meta.title ?? "Untitled"} (#${doc?.id ?? "?"})`;
  const out = [heading, "=".repeat(heading.length)];
  out.push(`Author    : ${meta.author ? toHex(fromHex(meta.author)) : "(unknown)"}`);
  out.push(`Status    : ${meta.scope ? cap(meta.scope) : "—"}`);
  out.push(`Created   : ${fmtTime(meta.created)}`);
  out.push(`Edited    : ${fmtTime(meta.edited)}`);
  out.push(`Format    : ${meta.format ?? "markdown"}`);
  out.push(`Signature : ${meta.signature ? "Present" : "Unsigned"}`);
  out.push("", doc?.content ?? "", "");
  const comments = Array.isArray(doc?.comments) ? doc.comments : [];
  if (comments.length) {
    out.push("Updates", "=======");
    for (const c of comments) {
      const ts = `#${c.id} · ${fmtTime(c.created)}`;
      out.push("", ts, "-".repeat(ts.length), c.content ?? "");
    }
    out.push("");
  }
  return out.join("\n");
}

// --- Internal formatting utilities ----------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * File-backed storage adapter for a reticulum-js identity (128-byte private
 * key export). Implements the `loadKey()/saveKey()` contract expected by
 * {@link Identity.loadOrGenerate}.
 */
export class FileStorageAdapter {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
  }
  /** @returns {Promise<Uint8Array|null>} */
  async loadKey() {
    return existsSync(this.path) ? readFileSync(this.path) : null;
  }
  /** @param {Uint8Array} keyData */
  async saveKey(keyData) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, keyData, { mode: 0o600 });
  }
}

/**
 * Default identity path: a dedicated key for this skill, kept separate from the
 * human's rngit client identity so human and machine can hold different
 * permissions on the node.
 * @returns {string}
 */
export function defaultIdentityPath() {
  return join(homedir(), ".pi-rngit-work", "identity.key");
}

/**
 * Loads (or generates on first use) the client identity at `identityPath`
 * without connecting to the mesh. Used by the `identity` command to surface
 * the hash the node admin needs for the permission bootstrap.
 * @param {string} identityPath
 * @returns {Promise<import("reticulum-js").Identity>}
 */
export async function ensureIdentity(identityPath) {
  const storage = new FileStorageAdapter(identityPath);
  return Identity.loadOrGenerate(storage);
}

/**
 * Returns the 32-char hex hash of the client identity at `identityPath`,
 * generating the key on first use. Two calls on the same path are stable.
 * @param {string} identityPath
 * @returns {Promise<string>}
 */
export async function identityHashHex(identityPath) {
  const identity = await ensureIdentity(identityPath);
  return toHex(identity.identityHash);
}

/**
 * Resolves configuration from environment variables, falling back to
 * auto-discovery of the rngit target from project files.
 *
 * Target resolution order:
 *   1. `RNGIT_URL` / `RNGIT_TARGET` env var (explicit override)
 *   2. {@link discoverUrl} — `.git/config`, `package.json`, then docs
 *      (`AGENTS.md`, `README.md`, `CONTRIBUTING.md`) in `cwd`
 *
 * @param {Record<string, string|undefined>} [env] - Defaults to `process.env`.
 * @param {string} [cwd] - Directory to search for auto-discovery. Defaults to
 *   `process.cwd()`.
 * @returns {{
 *   targetHash: Uint8Array,
 *   group: string,
 *   repo: string,
 *   repoPath: string,
 *   rnsHost: string,
 *   rnsPort: number,
 *   identityPath: string,
 *   pathTimeoutMs: number,
 *   requestTimeoutMs: number,
 * }}
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const url = env.RNGIT_URL ?? env.RNGIT_TARGET ?? discoverUrl(cwd);
  let parsed;
  if (url) {
    parsed = parseRemoteUrl(url);
  } else if (env.RNGIT_TARGET_HASH && env.RNGIT_GROUP && env.RNGIT_REPO) {
    parsed = {
      targetHash: toHashBytes(env.RNGIT_TARGET_HASH),
      group: env.RNGIT_GROUP,
      repo: env.RNGIT_REPO,
      repoPath: `${env.RNGIT_GROUP}/${env.RNGIT_REPO}`,
    };
  } else {
    throw new ConfigError(
      "No rngit target configured. Set RNGIT_URL=rns://<hash>/<group>/<repo>, " +
        "put it in .git/config / package.json / a project doc, " +
        "or run from a directory where it can be discovered.",
    );
  }
  return {
    ...parsed,
    rnsHost: env.RNS_HOST ?? "127.0.0.1",
    rnsPort: Number(env.RNS_PORT ?? 42424),
    identityPath: env.RNGIT_IDENTITY ?? defaultIdentityPath(),
    pathTimeoutMs: Number(env.RNGIT_PATH_TIMEOUT_MS ?? 30000),
    requestTimeoutMs: Number(env.RNGIT_REQUEST_TIMEOUT_MS ?? 300000),
  };
}

/**
 * Auto-discovers the rngit target URL by walking up from `cwd` to the nearest
 * repository boundary (a directory containing `.git`), checking each level.
 *
 * At each directory, in order, the first hit wins:
 *   1. A git remote in `.git/config` whose URL starts with `rns://`
 *      (set up by `git clone rns://...` / `git-remote-rns`).
 *   2. A `package.json` field: `rngit`, `rngit.url`, `reticulum.rngit`, or an
 *      `rns://` `repository` / `repository.url`.
 *   3. The first `rns://` URL in `AGENTS.md`, `README.md`, or
 *      `CONTRIBUTING.md`.
 *
 * Walking up (rather than only checking `cwd`) means discovery works whether
 * the CLI is run from the project root, the skill directory, or a subdir.
 * Returns `null` when nothing is found before the repo boundary.
 *
 * @param {string} [cwd] - Defaults to `process.cwd()`.
 * @returns {string|null}
 */
export function discoverUrl(cwd = process.cwd()) {
  let dir = resolve(cwd);
  while (true) {
    const found = gitConfigUrl(dir) ?? packageJsonUrl(dir) ?? docsUrl(dir);
    if (found) return found;
    // Stop at a repository boundary so we never escape the project.
    if (existsSync(join(dir, ".git"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/** @param {string} cwd @returns {string|null} */
function gitConfigUrl(cwd) {
  const cfgPath = join(cwd, ".git", "config");
  if (!existsSync(cfgPath)) return null;
  const text = readFileSync(cfgPath, "utf-8");
  const m = text.match(RNS_URL_RE);
  return m ? m[0] : null;
}

/** @param {string} cwd @returns {string|null} */
function packageJsonUrl(cwd) {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }
  const candidates = [
    pkg.rngit?.url,
    pkg.rngit,
    pkg.reticulum?.rngit,
    pkg.repository?.url,
    pkg.repository,
  ];
  for (const c of candidates) {
    if (typeof c === "string") {
      const m = c.match(RNS_URL_RE);
      if (m) return m[0];
    }
  }
  return null;
}

/** @param {string} cwd @returns {string|null} */
function docsUrl(cwd) {
  for (const name of ["AGENTS.md", "README.md", "CONTRIBUTING.md"]) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf-8").match(RNS_URL_RE);
    if (m) return m[0];
  }
  return null;
}

// --- Client ---------------------------------------------------------------

/**
 * A client for the rngit work-document protocol.
 *
 * Each method maps to a `rngit work` operation. The client manages one Link per
 * instance: call {@link WorkClient.connect} once, then issue operations, then
 * {@link WorkClient.close}.
 */
export class WorkClient {
  /**
   * @param {object} options
   * @param {Uint8Array} options.targetHash - 16-byte destination hash of the rngit node.
   * @param {string} options.group - Repository group (first URL segment).
   * @param {string} options.repo - Repository name (second URL segment).
   * @param {string} [options.rnsHost="127.0.0.1"] - Host of the local rnsd TCP interface.
   * @param {number} [options.rnsPort=42424] - Port of the local rnsd TCP interface.
   * @param {string} [options.identityPath] - Path to a reticulum-js identity key.
   * @param {import("reticulum-js").Identity["storage"]} [options.storageAdapter] - Custom identity storage.
   * @param {number} [options.pathTimeoutMs=30000] - Max time to learn the remote identity.
   * @param {number} [options.requestTimeoutMs=300000] - Per-request response timeout.
   * @param {number} [options.identifyDelayMs=150] - Pause after `identify()` so the
   *   responder records the identity before the first request.
   */
  constructor(options) {
    if (!options?.targetHash) throw new ConfigError("targetHash is required");
    if (!options?.group) throw new ConfigError("group is required");
    if (!options?.repo) throw new ConfigError("repo is required");
    this.targetHash = toHashBytes(options.targetHash);
    this.group = options.group;
    this.repo = options.repo;
    this.repoPath = `${options.group}/${options.repo}`;
    this.rnsHost = options.rnsHost ?? "127.0.0.1";
    this.rnsPort = options.rnsPort ?? 42424;
    this.pathTimeoutMs = options.pathTimeoutMs ?? 30000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300000;
    this.identifyDelayMs = options.identifyDelayMs ?? 150;
    this.storage =
      options.storageAdapter ??
      new FileStorageAdapter(options.identityPath ?? defaultIdentityPath());

    /** @type {Reticulum|null} */ this.rns = null;
    /** @type {import("reticulum-js").Identity|null} */ this.identity = null;
    /** @type {import("reticulum-js").Identity|null} */ this.remoteIdentity = null;
    /** @type {import("reticulum-js").Link|null} */ this.link = null;
  }

  /**
   * Connects to the mesh, learns the remote identity, establishes a Link and
   * identifies the client. Must be called before any operation.
   * @returns {Promise<void>}
   */
  async connect() {
    // rngit sends bz2-compressed Resources, so a bz2 module is mandatory.
    this.bz2 = await createBz2();
    this.rns = new Reticulum({
      storageAdapter: this.storage,
      compressionProvider: this.bz2,
    });
    const shared = await LocalClientInterface.connectToSharedInstance();
    if (shared) {
      this.rns.addInterface(shared, true);
    } else {
      const auto = new AutoInterface({ name: "auto" });
      await auto.connect();
      rns.addInterface(auto, true);
      if (this.rnsHost && this.rnsPort) {
        const tcp = new TCPClientInterface({ host: this.rnsHost, port: this.rnsPort });
        await tcp.connect();
        this.rns.addInterface(tcp, true);
      }
    }

    this.identity = await Identity.loadOrGenerate(this.rns.storage);

    const remote = await waitForIdentity(
      this.rns,
      this.targetHash,
      this.pathTimeoutMs,
    );
    if (!remote) {
      throw new Error(
        `Could not learn an identity for ${toHex(this.targetHash)}. ` +
          "Is the node reachable and has it announced?",
      );
    }
    this.remoteIdentity = remote;

    const dest = await Destination.OUT(
      ASPECT,
      DestType.SINGLE,
      this.remoteIdentity,
      this.rns,
    );
    this.link = await dest.createLink();
    // reticulum-js does not propagate Reticulum.compressionProvider to Links,
    // so inject the bz2 module directly (needed for rngit's compressed responses).
    this.link.bz2 = this.bz2;
    await this.link.identify(this.identity);
    // Give the responder a tick to process LINKIDENTIFY before the first request.
    await sleep(this.identifyDelayMs);
  }

  /**
   * Sends a `/mgmt/work` request and decodes the response.
   * @param {Record<string, any>} fields
   * @returns {Promise<any>}
   * @protected
   */
  async _send(fields) {
    if (!this.link) throw new Error("Not connected; call connect() first.");
    const data = buildRequest(this.repoPath, fields);
    const response = await this.link.request(PATH_WORK, data, {
      timeout: this.requestTimeoutMs,
    });
    return parseResponse(response);
  }

  /**
   * Lists work documents.
   * @param {"active"|"completed"|"proposed"|"all"} [scope="active"]
   * @returns {Promise<Record<string, any[]>>}
   */
  async list(scope = "active") {
    return this._send({ operation: "list", scope });
  }

  /**
   * Views a single document (body + update history).
   * @param {number|string} docId
   * @param {"active"|"completed"|"proposed"|"all"} [scope="all"]
   * @returns {Promise<any>}
   */
  async view(docId, scope = "all") {
    return this._send({ operation: "view", doc_id: Number(docId), scope });
  }

  /**
   * Creates a new active work document. Requires `write`+`interact` permission.
   * @param {string} title
   * @param {string} content - Markdown body.
   * @returns {Promise<{id: number, scope: string}>}
   */
  async create(title, content) {
    // The server validates the signature over content.strip(), so sign and send
    // the trimmed body (also what it stores).
    const body = content.trim();
    const signature = await this.identity.sign(utf8(body));
    return this._send({
      operation: "create",
      title,
      content: body,
      format: "markdown",
      signature,
    });
  }

  /**
   * Proposes a new document (lands in the `proposed` scope). Requires `propose`
   * permission.
   * @param {string} title
   * @param {string} content
   * @returns {Promise<{id: number, scope: string}>}
   */
  async propose(title, content) {
    const body = content.trim();
    const signature = await this.identity.sign(utf8(body));
    return this._send({
      operation: "propose",
      title,
      content: body,
      format: "markdown",
      signature,
    });
  }

  /**
   * Edits an existing document's content and/or title. Only the original author
   * may edit. Requires `write`+`interact` permission.
   * @param {number|string} docId
   * @param {string} content - New markdown body (signed).
   * @param {{title?: string, scope?: string}} [options]
   * @returns {Promise<null>}
   */
  async edit(docId, content, { title, scope = "active" } = {}) {
    const body = content.trim();
    const signature = await this.identity.sign(utf8(body));
    return this._send({
      operation: "edit",
      doc_id: Number(docId),
      scope,
      content: body,
      title,
      signature,
    });
  }

  /**
   * Adds an update (comment) to a document. Requires `interact` permission.
   * Maps to the `rngit work update` operation.
   * @param {number|string} docId
   * @param {string} content
   * @param {"active"|"completed"|"proposed"|"all"} [scope="active"]
   * @returns {Promise<{id: number}>}
   */
  async update(docId, content, scope = "active") {
    return this._send({
      operation: "comment",
      doc_id: Number(docId),
      scope,
      content,
      format: "markdown",
    });
  }

  /**
   * Marks a document complete (moves it to the `completed` scope).
   * @param {number|string} docId
   * @returns {Promise<{id: number}>}
   */
  async complete(docId) {
    return this._send({ operation: "complete", doc_id: Number(docId) });
  }

  /**
   * Reactivates a completed/proposed document (moves it to `active`).
   * @param {number|string} docId
   * @returns {Promise<{id: number}>}
   */
  async activate(docId) {
    return this._send({ operation: "activate", doc_id: Number(docId) });
  }

  /**
   * Tears down the link. Safe to call multiple times.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.link) {
      try {
        await this.link.teardown();
      } catch {
        /* ignore — best-effort graceful close */
      }
      this.link = null;
    }
  }
}

// --- Internals ------------------------------------------------------------

/**
 * Polls for the remote identity, requesting a path up front. Resolves `null` on
 * timeout (mirrors `examples/nomadnet_fetch.js`).
 * @param {Reticulum} rns
 * @param {Uint8Array} destinationHash
 * @param {number} timeoutMs
 * @returns {Promise<import("reticulum-js").Identity|null>}
 */
async function waitForIdentity(rns, destinationHash, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  try {
    await rns.transport.requestPath(destinationHash);
  } catch {
    /* best-effort; poll will retry */
  }
  while (Date.now() < deadline) {
    const identity = await Destination.recall(destinationHash);
    if (identity) return identity;
    await sleep(1000);
  }
  return null;
}

/** @param {string} s */
function utf8(s) {
  return new TextEncoder().encode(s);
}

/** @param {number} ms */
function fmtTime(ms) {
  if (!ms) return "unknown";
  return new Date(ms * 1000).toISOString().replace("T", " ").slice(0, 19);
}

/** @param {string} s */
function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** @param {string} s @param {number} width */
function pad(s, width) {
  return s.length >= width ? s.slice(0, width - 1) + "…" : s + " ".repeat(width - s.length);
}
