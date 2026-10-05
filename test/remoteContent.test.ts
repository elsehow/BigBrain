import { expect, test } from "bun:test";
import { publicUrl, remoteContentRoutes } from "../lib/remoteContent";

test("the engine fetches only public web addresses for a source's images and pages", async () => {
  for (const url of ["http://127.0.0.1:4747/", "http://localhost/", "http://192.168.1.4/x.png", "http://10.0.0.1/", "http://[::1]/", "http://169.254.169.254/", "file:///etc/passwd", "not a url"])
    expect(await publicUrl(url)).toBeNull();
  expect((await publicUrl("http://93.184.215.14/a.png"))?.href).toBe("http://93.184.215.14/a.png");
});

test("remote content off: both routes refuse before fetching anything", async () => {
  for (const route of remoteContentRoutes(() => false)) {
    let status = 0;
    const res = { writeHead: (s: number) => { status = s; }, end: () => {} };
    await route.handler({ res, url: new URL(`http://x${route.path}?url=http%3A%2F%2F93.184.215.14%2F`) } as never);
    expect(status).toBe(403);
  }
});
