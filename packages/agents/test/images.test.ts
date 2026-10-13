/**
 * The machine image on this computer (images.ts): fetched once against its
 * pins, refused when it isn't the pinned file, unpacked sparse, pruned.
 * A local server stands in for the release host; the files are invented.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { MachineImages, machineArch, unpackSparse, type Pins } from "../src";

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), name)); roots.push(d); return d; };
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// an invented disk: 8 MiB, mostly zeros, a little written
const disk = Buffer.alloc(8 * 1024 * 1024);
disk.write("orrery superblock", 1024);
disk.write("a file's bytes", 5 * 1024 * 1024 + 7);
const files = { vmlinuz: Buffer.from("an invented kernel"), "initramfs.cpio": Buffer.from("an invented initramfs"), "rootfs.img.gz": gzipSync(disk) };

let server: ReturnType<typeof Bun.serve>, served: string[] = [], tamper = false;
beforeAll(() => {
  server = Bun.serve({ port: 0, fetch(req) {
    const name = new URL(req.url).pathname.split("/").pop()! as keyof typeof files;
    served.push(name);
    const body = files[name];
    if (!body) return new Response("no", { status: 404 });
    return new Response(tamper && name === "vmlinuz" ? Buffer.from("an altered kernel!") : body);
  } });
});
afterAll(() => server?.stop(true));

function pins(): Pins {
  const pin = (name: keyof typeof files) => ({ name, sha256: sha(files[name]), size: files[name].length });
  return { protocol: 1, base: `http://127.0.0.1:${server.port}/machine`, arch: { [machineArch()!]: { kernel: pin("vmlinuz"), initramfs: pin("initramfs.cpio"), rootfs: pin("rootfs.img.gz") } } };
}

describe.skipIf(!machineArch())("machine images", () => {
  test("fetched once, checked, and the disk unpacked sparse and whole", async () => {
    const dir = scratch("images-");
    const images = new MachineImages({ dir, pins: pins() });
    expect(images.missing()).toBe(files.vmlinuz.length + files["initramfs.cpio"].length + files["rootfs.img.gz"].length);
    const seen: string[] = [];
    const img = await images.ensure(p => seen.push(p.file));
    expect(readFileSync(img.kernel, "utf8")).toBe("an invented kernel");
    expect(readFileSync(img.rootfs).equals(disk)).toBe(true);
    expect(statSync(img.rootfs).blocks * 512).toBeLessThan(disk.length / 4);
    expect(img.id).toBe(sha(files["rootfs.img.gz"]));
    expect(seen).toContain("rootfs.img.gz");
    expect(existsSync(`${img.rootfs}.gz`)).toBe(false);
    served = [];
    await images.ensure();
    expect(served).toEqual([]);
    expect(images.missing()).toBe(0);
  });

  test("a file that isn't the pinned one is refused and not kept", async () => {
    const dir = scratch("images-bad-");
    tamper = true;
    try { await expect(new MachineImages({ dir, pins: pins() }).ensure()).rejects.toThrow(/isn't the one this BigBrain expects/); }
    finally { tamper = false; }
    expect(existsSync(join(dir, "files", sha(files.vmlinuz)))).toBe(false);
    expect(existsSync(join(dir, "files", `${sha(files.vmlinuz)}.partial`))).toBe(false);
  });

  test("a missing file says so", async () => {
    const p = pins();
    p.arch[machineArch()!]!.kernel.name = "nothing-here";
    await expect(new MachineImages({ dir: scratch("images-404-"), pins: p }).ensure()).rejects.toThrow(/HTTP 404/);
  });

  test("prune keeps what disks came from and what the pins name", async () => {
    const dir = scratch("images-prune-");
    const images = new MachineImages({ dir, pins: pins() });
    const img = await images.ensure();
    writeFileSync(join(dir, "rootfs", "0".repeat(64) + ".img"), "an older rootfs");
    writeFileSync(join(dir, "files", "1".repeat(64)), "an older kernel");
    images.prune([]);
    expect(existsSync(img.rootfs)).toBe(true);
    expect(existsSync(img.kernel)).toBe(true);
    expect(existsSync(join(dir, "rootfs", "0".repeat(64) + ".img"))).toBe(false);
    expect(existsSync(join(dir, "files", "1".repeat(64)))).toBe(false);
  });

  test("a local image folder is booted as it is", async () => {
    const images = new MachineImages({ dir: scratch("images-local-"), local: "/somewhere/out" });
    expect((await images.ensure()).kernel).toBe("/somewhere/out/vmlinuz");
    expect(images.missing()).toBe(0);
  });
});

test("unpackSparse: a tail shorter than a block, zeros and not", async () => {
  const dir = scratch("sparse-");
  for (const body of [Buffer.alloc(100_003), Buffer.concat([Buffer.alloc(70_000), Buffer.from("end")])]) {
    writeFileSync(join(dir, "x.gz"), gzipSync(body));
    await unpackSparse(join(dir, "x.gz"), join(dir, "x"));
    expect(readFileSync(join(dir, "x")).equals(body)).toBe(true);
  }
});
