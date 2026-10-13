/**
 * egressPolicy.ts — what a contained desktop's machine may do at a host, not
 * only which hosts it may reach (the plan's Phase 4).
 *
 * The egress proxy terminates TLS for a contained desktop's allowlisted
 * hosts with a certificate from this install's own CA, which only the
 * machines trust, and applies a host's mode to each request:
 *
 * - "read": GET, HEAD and OPTIONS, and git's fetch (POST …/git-upload-pack);
 *   never a push (git-receive-pack) or any other write. Registries, GitHub
 *   and the hosts the person adds are read, unless they mark one otherwise.
 * - "upload": every method.
 * - "tunnel": no termination, an opaque tunnel as before: for a service that
 *   pins its certificates. It can upload, so taint closes it.
 *
 * A tainted desktop keeps its read hosts and loses the rest.
 *
 * The CA's key stays in ~/.config/bigbrain/machine-ca (0600); only its
 * certificate goes into machines. Certificates are made with openssl (macOS
 * and Linux ship it), one per host, kept beside the CA.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HostMode = "read" | "upload" | "tunnel";
export const HOST_MODES: readonly HostMode[] = ["read", "upload", "tunnel"];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a request may go to a host in this mode; the refusal's words when not. */
export function permitted(mode: HostMode, method: string, path: string): string | undefined {
  if (mode !== "read") return undefined;
  const [pathname = "", query = ""] = path.split("?");
  // a push, however it starts: the advertisement or the pack
  if (pathname.endsWith("/git-receive-pack") || /(?:^|&)service=git-receive-pack(?:&|$)/.test(query)) return "it pushes to a repository, and this host is read-only";
  if (READ_METHODS.has(method.toUpperCase())) return undefined;
  // git fetch posts its wants to upload-pack: a read
  if (method.toUpperCase() === "POST" && pathname.endsWith("/git-upload-pack")) return undefined;
  return `${method.toUpperCase()} writes, and this host is read-only`;
}

const LEAF_DAYS = 30;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** This install's CA for machines, and the certificates it makes for hosts. */
export class MachineCA {
  readonly dir: string;
  private leaves = new Map<string, { key: string; cert: string; until: number }>();
  private openssl: string;

  constructor(o: { dir?: string; openssl?: string } = {}) {
    this.dir = o.dir ?? join(homedir(), ".config", "bigbrain", "machine-ca");
    this.openssl = o.openssl ?? (existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl");
  }

  private get keyPath() { return join(this.dir, "ca.key"); }
  private get certPath() { return join(this.dir, "ca.crt"); }

  private run(args: string[], cwd: string): void {
    execFileSync(this.openssl, args, { cwd, stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  }

  /** The CA's certificate (PEM), made on first use: what machines are told to trust. */
  cert(): string {
    if (!existsSync(this.certPath) || !existsSync(this.keyPath)) this.create();
    return readFileSync(this.certPath, "utf8");
  }

  private create(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const work = join(this.dir, `.new-${randomBytes(4).toString("hex")}`);
    mkdirSync(work, { mode: 0o700 });
    try {
      writeFileSync(join(work, "ca.cnf"), [
        "[req]", "distinguished_name = dn", "x509_extensions = v3_ca", "prompt = no",
        "[dn]", "CN = BigBrain desktop machines (this computer only)", "O = BigBrain",
        "[v3_ca]", "basicConstraints = critical, CA:TRUE, pathlen:0", "keyUsage = critical, keyCertSign, cRLSign", "subjectKeyIdentifier = hash",
      ].join("\n") + "\n");
      this.run(["req", "-x509", "-new", "-nodes", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-config", "ca.cnf", "-keyout", "ca.key", "-out", "ca.crt"], work);
      chmodSync(join(work, "ca.key"), 0o600);
      renameSync(join(work, "ca.key"), this.keyPath);
      renameSync(join(work, "ca.crt"), this.certPath);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }

  /** A certificate for one host, signed by the CA: kept beside it, made again before it expires. */
  leaf(host: string): { key: string; cert: string } {
    const h = host.toLowerCase();
    if (!HOST.test(h)) throw new Error(`Not a host name: ${h.slice(0, 80)}`);
    const known = this.leaves.get(h);
    if (known && known.until > Date.now() + 86_400_000) return known;
    this.cert();
    const dir = join(this.dir, "hosts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyFile = join(dir, `${h}.key`), certFile = join(dir, `${h}.crt`);
    let cert = existsSync(certFile) ? readFileSync(certFile, "utf8") : "";
    let until = cert ? Date.parse(new X509Certificate(cert).validTo) : 0;
    if (!cert || !existsSync(keyFile) || until < Date.now() + 86_400_000) {
      const work = join(dir, `.new-${randomBytes(4).toString("hex")}`);
      mkdirSync(work, { mode: 0o700 });
      try {
        writeFileSync(join(work, "leaf.cnf"), [
          "[req]", "distinguished_name = dn", "prompt = no", "[dn]", `CN = ${h}`,
          "[v3]", "basicConstraints = critical, CA:FALSE", "keyUsage = critical, digitalSignature, keyEncipherment",
          "extendedKeyUsage = serverAuth", `subjectAltName = DNS:${h}`,
        ].join("\n") + "\n");
        this.run(["req", "-new", "-nodes", "-newkey", "rsa:2048", "-config", "leaf.cnf", "-keyout", "leaf.key", "-out", "leaf.csr"], work);
        // `openssl ca`, for its -startdate: valid from an hour ago, so a machine's clock a moment behind this one's still takes it
        writeFileSync(join(work, "index.txt"), "");
        writeFileSync(join(work, "serial"), `${randomBytes(12).toString("hex")}\n`);
        writeFileSync(join(work, "sign.cnf"), [
          "[ca]", "default_ca = this", "[this]", "database = index.txt", "new_certs_dir = .", "serial = serial",
          "default_md = sha256", "policy = any", "unique_subject = no", "[any]", "commonName = supplied",
        ].join("\n") + "\n");
        const stamp = (t: number) => new Date(t).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
        this.run(["ca", "-batch", "-notext", "-config", "sign.cnf", "-cert", this.certPath, "-keyfile", this.keyPath, "-in", "leaf.csr", "-out", "leaf.crt",
          "-startdate", stamp(Date.now() - 3_600_000), "-enddate", stamp(Date.now() + LEAF_DAYS * 86_400_000), "-extfile", "leaf.cnf", "-extensions", "v3"], work);
        chmodSync(join(work, "leaf.key"), 0o600);
        renameSync(join(work, "leaf.key"), keyFile);
        renameSync(join(work, "leaf.crt"), certFile);
      } finally { rmSync(work, { recursive: true, force: true }); }
      cert = readFileSync(certFile, "utf8");
      until = Date.parse(new X509Certificate(cert).validTo);
    }
    const leaf = { key: readFileSync(keyFile, "utf8"), cert, until };
    this.leaves.set(h, leaf);
    return leaf;
  }
}
