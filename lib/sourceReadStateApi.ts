import { ApplicationActions, userActionId } from "./applicationActions";
import { createSourceReadStateService } from "./sourceReadState";
import { createEmailReadStateAdapter } from "./emailReadState";
import { json, readBody, type Route } from "./httpx";

export const sourceReadStates = createSourceReadStateService([createEmailReadStateAdapter(undefined, { userSeen: true })]);

export function sourceReadStateRoutes(root: string, service = sourceReadStates, actions = new ApplicationActions(root)): Route[] {
  return [
    { method: "GET", path: "/api/source/read-state", handler: ({ res, url }) => {
      void service.refresh(root, url.searchParams.get("refresh") === "1").then(sources => json(res, 200, { sources, scope: "stored_sources" }))
        .catch(() => json(res, 503, { error: "Source read state is unavailable." }));
    } },
    { method: "POST", path: "/api/source/read-state", handler: ({ req, res }) => {
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
        return json(res, 415, { error: "Read-state changes require application/json." });
      if (req.headers.origin) {
        try {
          const origin = new URL(req.headers.origin);
          if (origin.host !== req.headers.host || origin.protocol !== "http:") throw new Error();
        } catch { return json(res, 403, { error: "Read-state changes require the app's own origin." }); }
      }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req, 32_768));
          if (!Array.isArray(body?.paths) || body.paths.some((p: unknown) => typeof p !== "string") || typeof body.unread !== "boolean") throw new Error("Choose source paths and a read state.");
          const actionId = userActionId(body.actionId);
          const result = await actions.execute({ actor: { kind: "user", id: "desktop" }, request: actionId, operation: "source_set_unread",
            scope: body.paths, payload: { paths: body.paths, unread: body.unread } }, {
              // This desktop-only operation intentionally has different policy from agent live writes.
              // The provider adapter rechecks current credentials and Gmail's Seen-only ceiling.
              authorize: () => {}, execute: () => service.setUnread(root, body.paths, body.unread, { actions, request: actionId, actor: { kind: "user", id: "desktop" } }),
            });
          json(res, 200, result); // Per-item receipts preserve partial failures.
        } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "Invalid read-state request." }); }
      })();
    } },
  ];
}
