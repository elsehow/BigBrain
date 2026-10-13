/**
 * images.ts — the machine image this engine boots, fetched once and kept
 * (the plan's "Versioning and release").
 *
 * packages/agents/machine.json pins, per architecture, the kernel, the
 * initramfs and the gzipped rootfs by sha256 and size. The first contained
 * desktop downloads what isn't here, checks each file against its pin
 * before keeping it, and unpacks the rootfs sparse (image.ts). Kernel and
 * initramfs are kept by their own hashes, apart from the rootfs: a new
 * guest agent is a new initramfs, and boots on every existing disk; only a
 * new rootfs means new disks.
 *
 *   <dir>/files/<sha256>          a kernel or an initramfs
 *   <dir>/rootfs/<sha256>.img     a rootfs, by its .gz's sha256: a disk's origin
 *
 * BIGBRAIN_MACHINE_IMAGE names a folder to boot as it is instead (a local
 * `bun run vm:image`), with nothing downloaded or checked.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { unpackSparse } from "./image";
import { imageAt, type MachineImage } from "./machine";
import { AgentsError } from "./workspace";

export interface PinnedFile { name: string; sha256: string; size: number }
export interface Pins {
  protocol: number;
  /** Which CI run built the pinned files: what the maintainer downloads and publishes. */
  built?: string;
  /** Where the files are: <base>/<arch>/<sha256>/<name>. */
  base: string;
  arch: Partial<Record<Arch, { kernel: PinnedFile; initramfs: PinnedFile; rootfs: PinnedFile }>>;
}
export type Arch = "arm64" | "amd64";

export const PINS = resolve(import.meta.dir, "../machine.json");
export const machineArch = (): Arch | undefined => process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;

export function readPins(path = PINS): Pins { return JSON.parse(readFileSync(path, "utf8")) as Pins; }

export interface ImagesOptions {
  /** Default: ~/.local/share/bigbrain/machine. */
  dir?: string;
  pins?: Pins;
  /** A local image folder, booted as it is (BIGBRAIN_MACHINE_IMAGE). */
  local?: string;
  /** How a file is fetched; tests stand in a local server. */
  fetch?: typeof fetch;
}

export interface Progress { file: string; got: number; total: number }

export class MachineImages {
  readonly dir: string;
  private pins?: Pins;
  private ensuring?: Promise<MachineImage>;

  constructor(private o: ImagesOptions = {}) {
    this.dir = o.dir ?? join(homedir(), ".local", "share", "bigbrain", "machine");
    this.pins = o.pins;
  }

  private local(): string | undefined { return this.o.local ?? process.env.BIGBRAIN_MACHINE_IMAGE; }

  private pinned() {
    const pins = this.pins ??= readPins();
    const arch = machineArch();
    const files = arch && pins.arch[arch];
    if (!files) throw new AgentsError(`There is no desktop machine for this computer (${process.arch}).`);
    return { pins, arch: arch!, files };
  }

  /** How much is still to download, in bytes; 0 when the image is here. */
  missing(): number {
    if (this.local()) return 0;
    const { files } = this.pinned();
    return [files.kernel, files.initramfs].filter(f => !existsSync(this.file(f))).reduce((n, f) => n + f.size, 0)
      + (existsSync(this.rootfs(files.rootfs)) ? 0 : files.rootfs.size);
  }

  private file(f: PinnedFile): string { return join(this.dir, "files", f.sha256); }
  private rootfs(f: PinnedFile): string { return join(this.dir, "rootfs", `${f.sha256}.img`); }

  /** The image, downloaded, checked and unpacked if it isn't here yet. */
  ensure(progress?: (p: Progress) => void, signal?: AbortSignal): Promise<MachineImage> {
    return this.ensuring ??= this.fetchAll(progress, signal).finally(() => { this.ensuring = undefined; });
  }

  private async fetchAll(progress?: (p: Progress) => void, signal?: AbortSignal): Promise<MachineImage> {
    const local = this.local();
    if (local) return { ...imageAt(local), id: `local:${resolve(local)}` };
    const { pins, arch, files } = this.pinned();
    for (const f of [files.kernel, files.initramfs]) {
      if (!existsSync(this.file(f))) await this.download(`${pins.base}/${arch}/${f.sha256}/${f.name}`, f, this.file(f), progress, signal);
    }
    const disk = this.rootfs(files.rootfs);
    if (!existsSync(disk)) {
      const gz = `${disk}.gz`;
      await this.download(`${pins.base}/${arch}/${files.rootfs.sha256}/${files.rootfs.name}`, files.rootfs, gz, progress, signal);
      progress?.({ file: "unpacking", got: 0, total: 0 });
      try { await unpackSparse(gz, disk); } finally { rmSync(gz, { force: true }); }
    }
    return { kernel: this.file(files.kernel), initramfs: this.file(files.initramfs), rootfs: disk, id: files.rootfs.sha256 };
  }

  /** One file, to a temporary name, checked against its pin, then into place. */
  private async download(url: string, pin: PinnedFile, to: string, progress?: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
    mkdirSync(join(to, ".."), { recursive: true });
    const tmp = `${to}.partial`;
    const res = await (this.o.fetch ?? fetch)(url, { signal }).catch((e: Error) => { throw new AgentsError(`Couldn't download the desktop machine (${e.message}).`); });
    if (!res.ok || !res.body) throw new AgentsError(`Couldn't download the desktop machine (${url}: HTTP ${res.status}).`);
    const hash = createHash("sha256");
    let got = 0;
    const body = Readable.fromWeb(res.body as never);
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      got += chunk.length;
      if (got > pin.size) body.destroy(new AgentsError(`The desktop machine's ${pin.name} is larger than it should be; it was not kept.`));
      progress?.({ file: pin.name, got, total: pin.size });
    });
    try { await pipeline(body, createWriteStream(tmp)); }
    catch (e) { rmSync(tmp, { force: true }); throw e instanceof AgentsError ? e : new AgentsError(`Couldn't download the desktop machine (${(e as Error).message}).`); }
    const sha = hash.digest("hex");
    if (got !== pin.size || sha !== pin.sha256) {
      rmSync(tmp, { force: true });
      throw new AgentsError(`The desktop machine's ${pin.name} isn't the one this BigBrain expects (sha256 ${sha.slice(0, 12)}…, ${got} bytes); it was not kept.`);
    }
    renameSync(tmp, to);
  }

  /** Remove every rootfs no disk came from, and every kernel or initramfs the pins don't name. Returns bytes freed. */
  prune(referenced: Iterable<string>): number {
    const keep = new Set(referenced);
    let freed = 0;
    const gone = (path: string) => { try { freed += statSync(path).blocks * 512; } catch { /* already */ } rmSync(path, { force: true }); };
    let pinned: string[] = [];
    try { const { files } = this.pinned(); pinned = [files.kernel.sha256, files.initramfs.sha256]; keep.add(files.rootfs.sha256); } catch { /* none for here */ }
    for (const name of safeList(join(this.dir, "rootfs"))) if (!keep.has(name.replace(/\.img(\.gz)?(\.partial)?$/, ""))) gone(join(this.dir, "rootfs", name));
    for (const name of safeList(join(this.dir, "files"))) if (!pinned.includes(name)) gone(join(this.dir, "files", name));
    return freed;
  }
}

const safeList = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };

/** Read a whole file's sha256 (for pins written from a local build). */
export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}
