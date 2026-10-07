import { expect, test } from "bun:test";
import { fetchPublic, privateAddress, publicUrl, remoteContentRoutes } from "../lib/remoteContent";

test("the engine fetches only public web addresses for a source's images and pages", async () => {
  for (const url of ["http://127.0.0.1:4747/", "http://localhost/", "http://192.168.1.4/x.png", "http://10.0.0.1/", "http://[::1]/", "http://169.254.169.254/", "file:///etc/passwd", "not a url",
    // spellings the URL parser turns into a private address
    "http://0x7f.1/", "http://2130706433/", "http://017700000001/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:c0a8:101]/", "http://[::ffff:a9fe:a9fe]/", "http://[64:ff9b::7f00:1]/"])
    expect(await publicUrl(url)).toBeNull();
  expect((await publicUrl("http://93.184.215.14/a.png"))?.url.href).toBe("http://93.184.215.14/a.png");
});

test("every non-public address form is refused, whatever IPv6 spelling carries it", () => {
  for (const ip of [
    "0.0.0.0", "0.1.2.3", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.8.8.8", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.170", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fe80::1%en0", "febf::1", "fec0::1", "fc00::1", "fd12:3456::1", "ff02::1", "ff05::1:3", "100::1", "2001:db8::1", "3fff::1",
    // IPv4-mapped, hex and dotted
    "::ffff:7f00:1", "::ffff:c0a8:101", "::ffff:a9fe:a9fe", "::ffff:a00:1", "::FFFF:127.0.0.1", "::ffff:192.168.1.1", "0:0:0:0:0:ffff:7f00:0001",
    // IPv4-compatible, NAT64 (well-known and local-use), SIIT, 6to4, Teredo
    "::7f00:1", "::127.0.0.1", "::a9fe:a9fe", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::192.168.0.1", "64:ff9b:1::5db8:d70e", "::ffff:0:7f00:1",
    "2002:7f00:1::", "2002:c0a8:101::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    // not an address at all
    "", "example.com", "1.2.3", "::ffff:1.2.3.400",
  ]) expect([ip, privateAddress(ip)]).toEqual([ip, true]);
  for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "192.0.3.1", "2606:4700:4700::1111", "2a00:1450:4001::200e",
    "::ffff:5db8:d70e", "::ffff:93.184.215.14", "64:ff9b::5db8:d70e", "64:ff9b::93.184.215.14", "2002:5db8:d70e::1"])
    expect([ip, privateAddress(ip)]).toEqual([ip, false]);
});

const zone: Record<string, string[]> = { "public.test": ["2606:4700:4700::1111", "93.184.215.14"], "mixed.test": ["93.184.215.14", "10.0.0.5"], "inside.test": ["::ffff:c0a8:101"] };
const dns = async (host: string) => [...(zone[host] ?? [])];

test("a name is fetched only when every address it resolves to is public", async () => {
  expect((await publicUrl("https://public.test/a.png", dns))?.addrs).toEqual(["93.184.215.14", "2606:4700:4700::1111"]);
  for (const host of ["mixed.test", "inside.test", "unknown.test"]) expect(await publicUrl(`https://${host}/a.png`, dns)).toBeNull();
});

test("the fetch connects to the address that was checked, under the URL's own name", async () => {
  const calls: Array<{ url: string; init: { headers: Record<string, string>; tls?: { serverName: string } } }> = [];
  const get = (async (url: URL, init: never) => { calls.push({ url: url.href, init }); return new Response("ok"); }) as unknown as typeof fetch;
  const got = await fetchPublic("https://public.test:8443/a.png?x=1", "image/*", { dns, get });
  expect(got?.at.href).toBe("https://public.test:8443/a.png?x=1");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://93.184.215.14:8443/a.png?x=1");
  expect(calls[0]!.init.headers.host).toBe("public.test:8443");
  expect(calls[0]!.init.tls?.serverName).toBe("public.test");
});

test("a redirect is re-checked: one to a private address is refused before it is fetched", async () => {
  for (const location of ["http://127.0.0.1:4747/api/note", "http://[::ffff:7f00:1]/", "http://[64:ff9b::a9fe:a9fe]/latest", "https://inside.test/", "/../", "file:///etc/passwd"]) {
    const seen: string[] = [];
    const get = (async (url: URL) => {
      seen.push(url.href);
      return location === "/../" && seen.length > 1 ? new Response("ok") : new Response(null, { status: 302, headers: { location: location === "/../" ? "http://10.0.0.1/" : location } });
    }) as unknown as typeof fetch;
    expect(await fetchPublic("https://public.test/a.png", "image/*", { dns, get })).toBeNull();
    expect(seen).toEqual(["https://93.184.215.14/a.png"]);
  }
  // a public hop is followed, and the chain is bounded
  let hops = 0;
  const loop = (async () => { hops++; return new Response(null, { status: 302, headers: { location: "https://public.test/next" } }); }) as unknown as typeof fetch;
  expect(await fetchPublic("https://public.test/a.png", "image/*", { dns, get: loop })).toBeNull();
  expect(hops).toBe(5);
});

test("remote content off: both routes refuse before fetching anything", async () => {
  for (const route of remoteContentRoutes(() => false)) {
    let status = 0;
    const res = { writeHead: (s: number) => { status = s; }, end: () => {} };
    await route.handler({ res, url: new URL(`http://x${route.path}?url=http%3A%2F%2F93.184.215.14%2F`) } as never);
    expect(status).toBe(403);
  }
});
