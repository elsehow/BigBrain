/**
 * desktopNetwork.ts — where coding desktops' commands may reach, and what
 * they may never read (packages/agents/src/sandbox.ts).
 *
 * Beyond this machine, commands reach only the egress proxy's allowlist:
 * package registries and GitHub (DEFAULT_HOSTS), plus the hosts the person
 * adds in Settings, kept in the vault's .env like Pilot's folders. An entry
 * `localhost:<port>` lets them reach a local service a project uses, such as
 * a database; the engine's own ports never.
 */
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { canonical, DEFAULT_HOSTS, type SandboxPolicy } from "../packages/agents/src";
import { apiPort, pilotDevPort, pilotDevUiPort, sharedPort, webPort } from "./env";
import { readEnvValues, writeEnvValues } from "./envFile";
import { credentialPaths } from "./workPermissions";

const KEY = "BIGBRAIN_DESKTOP_HOSTS";
const MAX_HOSTS = 64;
const HOST = /^(?:\*\.)?(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOCAL = /^localhost:(\d{1,5})$/;

/** Private data beyond credential stores that commands never read: mail,
 * messages, browser profiles, privacy grants, other agents' configuration. */
const PRIVATE_DATA = ["Library/Mail", "Library/Messages", "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox",
  "Library/Application Support/com.apple.TCC", "Library/Application Support/Claude", "Library/Application Support/cool.bigbrain.desktop",
  ".config/git/credentials", ".cargo/credentials", ".cargo/credentials.toml", ".python_history", ".node_repl_history", ".psql_history", ".mysql_history"];

/** The engine's own servers: never reachable from a command, whatever the person allows. */
export const enginePorts = (): number[] => [...new Set([webPort(), apiPort(), sharedPort(), pilotDevPort(), pilotDevUiPort()])];

/** One allowlist entry, normalized, or why it can't be one. */
export function hostEntry(value: unknown): string {
  const v = typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : "";
  const port = LOCAL.exec(v)?.[1];
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) throw new Error(`${v} is not a port.`);
    if (enginePorts().includes(n)) throw new Error(`Port ${n} is BigBrain's own; desktops never reach it.`);
    return `localhost:${n}`;
  }
  if (!HOST.test(v)) throw new Error(`${typeof value === "string" ? value.trim() || "An empty entry" : "That"} is not a host name (registry.example.com, *.example.com) or a local port (localhost:5432).`);
  return v;
}

/** The hosts the person added. A saved entry that no longer qualifies grants nothing. */
export function savedDesktopHosts(root: string): string[] {
  try {
    const raw = JSON.parse(readEnvValues(root)[KEY] ?? "[]");
    return Array.isArray(raw) ? raw.flatMap(h => { try { return [hostEntry(h)]; } catch { return []; } }) : [];
  } catch { return []; }
}

export function saveDesktopHosts(root: string, hosts: unknown): string[] {
  if (!Array.isArray(hosts) || hosts.length > MAX_HOSTS) throw new Error(`Give up to ${MAX_HOSTS} hosts.`);
  const added = [...new Set(hosts.map(hostEntry))].filter(h => !DEFAULT_HOSTS.includes(h));
  writeEnvValues(root, { [KEY]: JSON.stringify(added) });
  return added;
}

/** Everything commands may reach: the defaults and the person's additions. */
export const desktopHosts = (root: string): string[] => [...DEFAULT_HOSTS, ...savedDesktopHosts(root)];

/** What a vault's desktops' commands are kept from: credential stores and
 * private data, the vault (only its secrets and machinery when the agents'
 * workspace sits inside it), and the engine's ports. */
export function sandboxPolicy(root: string, workspaceRoot: string): SandboxPolicy {
  return {
    deny: () => {
      const vault = canonical(root), work = canonical(workspaceRoot);
      const holdsWork = work === vault || work.startsWith(vault + sep);
      return [...credentialPaths(), ...PRIVATE_DATA.map(p => join(homedir(), p)),
        ...(holdsWork ? [] : [vault]), ...[".env", ".spool", ".state", ".git"].map(p => join(vault, p))];
    },
    ports: enginePorts,
    hosts: () => desktopHosts(root),
  };
}
