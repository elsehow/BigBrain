import { json, type Route } from "./httpx";
import { workDetail, type WorkHistory } from "./workHistory";

/** Retained conversations are evidence; no endpoint can resume their execution. */
export function workHistoryRoutes(history: WorkHistory): Route[] {
  return [{ method: "GET", path: "/api/pilot/work", handler: ({ url, res }) => {
    try {
      const id = url.searchParams.get("id");
      const ids = url.searchParams.get("ids")?.split(",");
      json(res, 200, id ? workDetail(history.get(id)) : {
        sessions: history.list().filter(s => !ids || ids.includes(s.id)), issues: history.loadIssues,
      });
    } catch { json(res, 404, { error: "Historical session not found" }); }
  } }];
}
