#!/usr/bin/env node
/**
 * @file work.js
 *
 * Command-line entrypoint for the `rngit-work` skill. Wraps {@link WorkClient}
 * so an agent (or a human) can manage rngit work documents without the
 * interactive editor that `rngit work` requires.
 *
 * Usage:
 *
 *   work.js list   [--scope active|completed|proposed|all]
 *   work.js view   <id> [--scope ...]
 *   work.js create <title...> --file <path|->   [--propose]
 *   work.js edit   <id> --file <path|-> [--title <t>] [--scope ...]
 *   work.js update <id> --file <path|-> [--scope ...]
 *   work.js complete <id>
 *   work.js activate <id>
 *
 * Content is read from `--file <path>`, or from stdin when `--file -` is given
 * (or `--file` is omitted). `--json` prints raw structured output instead of
 * the formatted tables.
 *
 * Configuration comes from environment variables (see `loadConfig`); the
 * `--url`, `--host`, `--port` and `--identity` flags override them for a run.
 */

import { readFileSync } from "node:fs";
import {
  WorkClient,
  ConfigError,
  WorkError,
  Status,
  defaultIdentityPath,
  identityHashHex,
  loadConfig,
  formatList,
  formatView,
} from "../../../src/work-client.js";

/** Operations recognised on the CLI. */
const KNOWN_OPERATIONS = new Set([
  "list",
  "view",
  "create",
  "propose",
  "edit",
  "update",
  "complete",
  "activate",
]);

main();

async function main() {
  const { operation, positional, flags } = parseArgs(process.argv.slice(2));
  if (!operation) return usage(0);
  // `identity` needs no target or network — it only loads the local key.
  if (operation === "identity") return runIdentity(flags);
  if (!KNOWN_OPERATIONS.has(operation)) {
    console.error(`Unknown operation: ${operation}`);
    return usage(1);
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    return fail(err, 1);
  }
  // CLI flag overrides.
  if (flags.url) {
    try {
      const { parseRemoteUrl } = await import("../../../src/work-client.js");
      const parsed = parseRemoteUrl(flags.url);
      Object.assign(config, parsed);
    } catch (err) {
      return fail(err, 1);
    }
  }
  if (flags.host) config.rnsHost = flags.host;
  if (flags.port) config.rnsPort = Number(flags.port);
  if (flags.identity) config.identityPath = flags.identity;

  const client = new WorkClient(config);
  const json = Boolean(flags.json);
  try {
    // reticulum-js logs at DEBUG to stdout; silence the whole connect→request→
    // teardown lifecycle unless --verbose, so only our result reaches stdout.
    const output = await withStdoutSilenced(Boolean(flags.verbose), async () => {
      try {
        await client.connect();
        switch (operation) {
          case "list":
            return await runList(client, flags, json);
          case "view":
            return await runView(client, positional, flags, json);
          case "create":
          case "propose":
            return await runCreate(client, operation, positional, flags, json);
          case "edit":
            return await runEdit(client, positional, flags, json);
          case "update":
            return await runUpdate(client, positional, flags, json);
          case "complete":
            return await runLifecycle(client, "complete", positional, json);
          case "activate":
            return await runLifecycle(client, "activate", positional, json);
          default:
            throw new ConfigError(`Unknown operation: ${operation}`);
        }
      } finally {
        await client.close();
      }
    });
    if (output !== undefined) console.log(output);
  } catch (err) {
    return fail(err, err instanceof WorkError ? 2 : 1);
  }
  process.exit(0);
}

// --- Operation runners (each returns its output string) -------------------

async function runList(client, flags, json) {
  const scope = flags.scope ?? "active";
  const result = await client.list(scope);
  return json ? JSON.stringify(result, null, 2) : formatList(result);
}

async function runView(client, positional, flags, json) {
  const id = requireId(positional);
  const scope = flags.scope ?? "all";
  const doc = await client.view(id, scope);
  return json ? JSON.stringify(doc, null, 2) : formatView(doc);
}

async function runCreate(client, operation, positional, flags, json) {
  const title = positional.join(" ").trim();
  if (!title) throw new ConfigError("No title given");
  const content = await readContent(flags.file);
  if (!content.trim()) throw new ConfigError("Content is empty");
  const usePropose = operation === "propose" || flags.propose === true;
  const result =
    usePropose
      ? await client.propose(title, content)
      : await client.create(title, content);
  return json
    ? JSON.stringify(result, null, 2)
    : `${usePropose ? "Proposed" : "Created"} ${result.scope} work document #${result.id} ("${title}")`;
}

async function runEdit(client, positional, flags, json) {
  const id = requireId(positional);
  const content = await readContent(flags.file);
  const result = await client.edit(id, content, {
    title: flags.title,
    scope: flags.scope ?? "active",
  });
  return json ? JSON.stringify(result, null, 2) : `Edited work document #${id}`;
}

async function runUpdate(client, positional, flags, json) {
  const id = requireId(positional);
  const content = await readContent(flags.file);
  const result = await client.update(id, content, flags.scope ?? "active");
  return json
    ? JSON.stringify(result, null, 2)
    : `Added update #${result.id} to work document #${id}`;
}

async function runLifecycle(client, op, positional, json) {
  const id = requireId(positional);
  const result = await client[op](id);
  return json
    ? JSON.stringify(result, null, 2)
    : `${op[0].toUpperCase()}${op.slice(1)}d work document #${result.id}`;
}

/**
 * Runs `fn` with stdout silenced (reticulum-js logs at DEBUG to stdout). When
 * `verbose` is true, leaves stdout alone so the logs aid debugging. `console.error`
 * is never silenced, so errors and usage still show.
 * @param {boolean} verbose
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function withStdoutSilenced(verbose, fn) {
  if (verbose) return fn();
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

/**
 * Prints (and, on first use, generates) pi's identity hash so the node admin
 * can grant it the permissions it needs. Requires no network.
 * @param {Record<string, any>} flags
 */
async function runIdentity(flags) {
  const identityPath = flags.identity ?? process.env.RNGIT_IDENTITY ?? defaultIdentityPath();
  const hash = await identityHashHex(identityPath);
  console.log("Pi rngit identity");
  console.log(`  key file : ${identityPath}`);
  console.log(`  hash     : ${hash}`);
  console.log("");
  console.log("To let this identity act, the rngit node admin must grant it");
  console.log("permissions, then (re)start rngit. Example (~/.rngit/config [access]):");
  console.log("");
  console.log(`  <group> = r:all, w:${hash}, i:${hash}`);
  console.log("");
  console.log("…or per repository, in a <repo>.allowed file next to the repo:");
  console.log("");
  console.log("  r:all");
  console.log(`  w:${hash}`);
  console.log(`  i:${hash}`);
  console.log("");
  console.log("Permission flags: r=read, w=write, i=interact, p=propose, adm=admin.");
  console.log("create/edit/update need w + i; propose needs p; list/view need r.");
}

// --- Arg parsing & helpers ------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const booleans = new Set(["json", "verbose", "propose"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (booleans.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { operation: positional.shift(), positional, flags };
}

/** @param {string[]} positional */
function requireId(positional) {
  const id = positional[0];
  if (id === undefined) throw new ConfigError("No document ID given");
  return id;
}

/**
 * Reads document content from a file path, or from stdin when the path is `-`
 * or omitted.
 * @param {string|undefined} source
 * @returns {Promise<string>}
 */
async function readContent(source) {
  if (!source || source === "-") return readStdin();
  return readFileSync(source, "utf-8");
}

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/** @param {unknown} err @param {number} code */
function fail(err, code) {
  const e = /** @type {Error} */ (err);
  if (e instanceof ConfigError) {
    console.error(`Config error: ${e.message}`);
  } else if (e instanceof WorkError) {
    let msg = `Remote rejected (${e.status}): ${e.message}`;
    if (e.status === Status.DISALLOWED) {
      msg +=
        "\n  -> pi's identity probably lacks permission. Run `work.js identity`" +
        " for its hash and ask the node admin to grant it" +
        " (w + i for create/edit/update, p for propose).";
    }
    console.error(msg);
  } else {
    console.error(`Error: ${e.message || e}`);
  }
  process.exit(code);
}

/** @param {number} code */
function usage(code) {
  console.error(`rngit work-document client

Usage:
  work.js list [--scope active|completed|proposed|all]
  work.js view <id> [--scope ...]
  work.js create <title...> --file <path|-> [--propose]
  work.js edit <id> --file <path|-> [--title <t>] [--scope ...]
  work.js update <id> --file <path|-> [--scope ...]
  work.js complete <id>
  work.js activate <id>
  work.js identity                        # print pi's identity hash (no network)

Content: --file <path> reads a file; --file - (or omitted) reads stdin.

Configuration (env vars):
  RNGIT_URL=rns://<hash>/<group>/<repo>   (or RNGIT_TARGET_HASH + RNGIT_GROUP + RNGIT_REPO)
  RNS_HOST, RNS_PORT                       (local rnsd, default 127.0.0.1:42424)
  RNGIT_IDENTITY                           (path to pi's identity key)

Flags --url --host --port --identity override the env vars for one run.
--json prints structured output instead of formatted text.`);
  process.exit(code);
}
