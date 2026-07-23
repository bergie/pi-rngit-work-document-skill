/**
 * @file bz2.js
 *
 * Adapts `@digitaldefiance/bzip2-wasm` to the @reticulum/core `Bzip2` interface
 * (`{ compress, decompress }`) that {@link import("@reticulum/core").Link} expects
 * on its `bz2` field for compressing/decompressing §10 Resources.
 *
 * rngit sends its `/mgmt/work` responses as bz2-compressed Resources, so a
 * client MUST inject a bz2 module or resource assembly fails with
 * "Resource is compressed but no bz2 module was provided".
 */

import BZip2 from "@digitaldefiance/bzip2-wasm";

/**
 * Creates and initialises a @reticulum/core-compatible bz2 adapter.
 *
 * `BZip2.init()` loads the WASM module, so this is async and must complete
 * before any Resource transfer.
 *
 * @returns {Promise<{compress: (data: Uint8Array) => Uint8Array, decompress: (data: Uint8Array, outputLen: number) => Uint8Array}>}
 */
export async function createBz2() {
  const bz = new BZip2();
  await bz.init();
  return {
    /** @param {Uint8Array} data */
    compress: (data) => bz.compress(data),
    /**
     * @param {Uint8Array} data
     * @param {number} outputLen - Expected uncompressed length (from the adv).
     */
    decompress: (data, outputLen) => bz.decompress(data, outputLen),
  };
}
