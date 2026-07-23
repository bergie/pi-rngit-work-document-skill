/**
 * Smoketests for the offline (network-free) helpers in work-client.js.
 *
 * These verify the rngit wire contract: integer map keys, status-byte response
 * framing, URL parsing and CLI formatting. End-to-end behaviour against a live
 * rngit node is covered manually (it requires mesh connectivity).
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MsgPack } from "@reticulum/core";
import {
  buildRequest,
  ConfigError,
  discoverUrl,
  formatList,
  formatView,
  IDX_REPOSITORY,
  identityHashHex,
  loadConfig,
  parseRemoteUrl,
  parseResponse,
  Status,
  statusLabel,
  toHashBytes,
  WorkError,
} from "../src/work-client.js";

const HASH_HEX = "3ea5aad068a337670f5bb8073226adb4";
const URL = `rns://${HASH_HEX}/public/reticulum-js`;

/** Makes an isolated fixture dir and returns its path. */
function fixture(setup) {
  const dir = mkdtempSync(join(tmpdir(), "rngit-work-"));
  setup(dir);
  return dir;
}

// --- parseRemoteUrl -------------------------------------------------------

test("parseRemoteUrl parses rns:// URLs", () => {
  const r = parseRemoteUrl(`rns://${HASH_HEX}/public/reticulum-js`);
  assert.equal(r.group, "public");
  assert.equal(r.repo, "reticulum-js");
  assert.equal(r.repoPath, "public/reticulum-js");
  assert.equal(r.targetHash.length, 16);
  assert.equal(r.targetHash[0], 0x3e);
});

test("parseRemoteUrl accepts the scheme-less form", () => {
  const r = parseRemoteUrl(`${HASH_HEX}/public/reticulum-js`);
  assert.equal(r.repoPath, "public/reticulum-js");
});

test("parseRemoteUrl rejects bad input", () => {
  assert.throws(() => parseRemoteUrl(""), ConfigError);
  assert.throws(() => parseRemoteUrl("rns://short/x/y"), ConfigError);
  assert.throws(
    () => parseRemoteUrl("rns://hash/only-one-segment"),
    ConfigError,
  );
});

// --- toHashBytes ----------------------------------------------------------

test("toHashBytes accepts hex and bytes", () => {
  const fromHexStr = toHashBytes(HASH_HEX);
  const fromBytes = toHashBytes(fromHexStr);
  assert.deepEqual(fromBytes, fromHexStr);
});

test("toHashBytes rejects wrong lengths", () => {
  assert.throws(() => toHashBytes("deadbeef"), ConfigError);
  assert.throws(() => toHashBytes(new Uint8Array(10)), ConfigError);
});

// --- buildRequest (the load-bearing integer-key contract) -----------------

test("buildRequest encodes IDX_REPOSITORY as an integer key on the wire", () => {
  const req = buildRequest("public/reticulum-js", {
    operation: "list",
    scope: "active",
  });
  assert.equal(req.get(IDX_REPOSITORY), "public/reticulum-js");
  assert.equal(req.get("operation"), "list");

  // On the wire this MUST be a fixmap whose first key is the integer 0,
  // not the string "0" — otherwise the Python server rejects it.
  const wire = MsgPack.encode(req);
  assert.equal(wire[0], 0x83, "fixmap header with 3 entries");
  assert.equal(wire[1], 0x00, "first key is the integer 0");
});

test("buildRequest omits undefined fields", () => {
  const req = buildRequest("g/r", { title: undefined, operation: "view" });
  assert.equal(req.size, 2);
  assert.equal(req.has("title"), false);
});

// --- parseResponse --------------------------------------------------------

function response(status, payload) {
  const body =
    payload === undefined ? new Uint8Array() : MsgPack.encode(payload);
  return new Uint8Array([status, ...body]);
}

test("parseResponse decodes an OK payload", () => {
  const decoded = parseResponse(
    response(Status.OK, { id: 9, scope: "active" }),
  );
  assert.equal(decoded.id, 9);
  assert.equal(decoded.scope, "active");
});

test("parseResponse returns null for an empty OK body", () => {
  assert.equal(parseResponse(new Uint8Array([Status.OK])), null);
});

test("parseResponse throws WorkError with the server message on failure", () => {
  const err = response(
    Status.DISALLOWED,
    new TextEncoder().encode("Not allowed"),
  );
  assert.throws(
    () => parseResponse(err),
    (e) =>
      e instanceof WorkError &&
      e.status === Status.DISALLOWED &&
      /Not allowed/.test(e.message),
  );
});

test("parseResponse rejects non-Uint8Array responses", () => {
  assert.throws(() => parseResponse(null), WorkError);
  assert.throws(() => parseResponse("nope"), WorkError);
});

test("statusLabel covers known codes", () => {
  assert.equal(statusLabel(Status.OK), "OK");
  assert.equal(statusLabel(Status.NOT_FOUND), "Not found");
  assert.match(statusLabel(99), /Unknown/);
});

// --- formatting -----------------------------------------------------------

test("formatList renders a table", () => {
  const out = formatList({
    active: [
      { id: 8, title: "Doc", author: "ab", created: 1748000000, comments: 2 },
    ],
  });
  assert.match(out, /Active documents/);
  assert.match(out, /Doc/);
  assert.match(out, /2/);
});

test("formatList handles empty result", () => {
  assert.match(formatList({ active: [] }), /No work documents found/);
});

test("formatView renders body and updates", () => {
  const out = formatView({
    id: 8,
    meta: {
      title: "T",
      created: 1748000000,
      edited: 1748000000,
      format: "markdown",
    },
    content: "Hello world",
    comments: [{ id: 1, created: 1748000000, content: "An update" }],
  });
  assert.match(out, /Hello world/);
  assert.match(out, /Updates/);
  assert.match(out, /An update/);
});

// --- loadConfig -----------------------------------------------------------

test("loadConfig reads RNGIT_URL", () => {
  const cfg = loadConfig(
    { RNGIT_URL: URL },
    fixture(() => {}),
  );
  assert.equal(cfg.repoPath, "public/reticulum-js");
  assert.equal(cfg.rnsHost, "127.0.0.1");
  assert.equal(cfg.rnsPort, 42424);
  assert.match(cfg.identityPath, /pi-rngit-work/);
});

test("loadConfig accepts component vars", () => {
  const cfg = loadConfig(
    {
      RNGIT_TARGET_HASH: HASH_HEX,
      RNGIT_GROUP: "public",
      RNGIT_REPO: "reticulum-js",
      RNS_PORT: "12345",
    },
    fixture(() => {}),
  );
  assert.equal(cfg.repoPath, "public/reticulum-js");
  assert.equal(cfg.rnsPort, 12345);
});

test("loadConfig throws without a target", () => {
  assert.throws(
    () =>
      loadConfig(
        {},
        fixture(() => {}),
      ),
    ConfigError,
  );
});

test("loadConfig falls back to discovery when no env is set", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "AGENTS.md"), `work docs at ${URL}`);
  });
  const cfg = loadConfig({}, dir);
  assert.equal(cfg.repoPath, "public/reticulum-js");
});

// --- discoverUrl ----------------------------------------------------------

test("discoverUrl finds an rns remote in .git/config", () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, ".git"));
    writeFileSync(
      join(d, ".git", "config"),
      `[remote "origin"]\n\turl = ${URL}\n\tfetch = +refs/*:refs/*\n`,
    );
  });
  assert.equal(discoverUrl(dir), URL);
});

test("discoverUrl reads a package.json rngit field", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "package.json"), JSON.stringify({ rngit: URL }));
  });
  assert.equal(discoverUrl(dir), URL);
});

test("discoverUrl reads repository.url when it is rns://", () => {
  const dir = fixture((d) => {
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ repository: { url: URL } }),
    );
  });
  assert.equal(discoverUrl(dir), URL);
});

test("discoverUrl finds a URL in docs", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "README.md"), `Clone with \`git clone ${URL}\`.`);
  });
  assert.equal(discoverUrl(dir), URL);
});

test("discoverUrl prefers .git/config over package.json over docs", () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".git", "config"), `\turl = ${URL}\n`);
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ rngit: "rns://aaa..." }),
    );
    writeFileSync(join(d, "AGENTS.md"), "rns://bbb...");
  });
  assert.equal(discoverUrl(dir), URL);
});

test("discoverUrl returns null when nothing matches", () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, ".git")); // repo boundary: keep the test hermetic
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(d, "README.md"), "no rns url here");
  });
  assert.equal(discoverUrl(dir), null);
});

test("discoverUrl walks up to a parent directory to find the URL", () => {
  const root = fixture((d) => {
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, "AGENTS.md"), `work docs at ${URL}`);
    mkdirSync(join(d, "sub", "deep"), { recursive: true });
  });
  assert.equal(discoverUrl(join(root, "sub", "deep")), URL);
});

// --- identity bootstrap ---------------------------------------------------

test("identityHashHex generates a 32-char hash and is stable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rngit-id-"));
  const keyPath = join(dir, "identity.key");
  const a = await identityHashHex(keyPath);
  const b = await identityHashHex(keyPath);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, b);
});
