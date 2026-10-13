/**
 * image.ts — the machine image on this computer: unpacked sparse, so the
 * 8 GiB disk takes what is written in it, not 8 GiB (the plan's "The machine
 * image", "Versioning and release").
 */
import { createReadStream, closeSync, ftruncateSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { createGunzip } from "node:zlib";

const BLOCK = 64 * 1024;

const ZEROS = Buffer.alloc(BLOCK);
/** Whether a block is all zeros (a native compare). */
const zero = (b: Buffer): boolean => b.equals(b.length === BLOCK ? ZEROS : ZEROS.subarray(0, b.length));

/** Gunzip `gz` into `out`, seeking over every all-zero 64 KiB block instead of writing it. Atomic: `out` appears whole or not at all. */
export async function unpackSparse(gz: string, out: string): Promise<{ size: number }> {
  const tmp = `${out}.partial`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "w", 0o644);
  let at = 0;
  let pending = Buffer.alloc(0);
  const flush = (block: Buffer) => {
    if (!zero(block)) writeSync(fd, block, 0, block.length, at);
    at += block.length;
  };
  try {
    for await (const chunk of createReadStream(gz).pipe(createGunzip({ chunkSize: BLOCK }))) {
      pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer;
      let off = 0;
      for (; off + BLOCK <= pending.length; off += BLOCK) flush(pending.subarray(off, off + BLOCK));
      pending = pending.subarray(off);
    }
    if (pending.length) {
      if (zero(pending)) at += pending.length;
      else { writeSync(fd, pending, 0, pending.length, at); at += pending.length; }
    }
    ftruncateSync(fd, at);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, out);
  return { size: at };
}

if (import.meta.main) {
  const [gz, out] = process.argv.slice(2);
  if (!gz || !out) { console.error("usage: bun packages/agents/src/image.ts <rootfs.img.gz> <rootfs.img>"); process.exit(2); }
  const { size } = await unpackSparse(gz, out);
  console.log(`${out}: ${size} bytes, sparse`);
}
