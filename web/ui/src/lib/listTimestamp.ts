export function listTimestamp(ms: number): string {
    if (!ms || !Number.isFinite(ms)) return "";
    const date = new Date(ms);
    // Exact UTC midnight represents a date-only source, not a capture time.
    if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0)
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return date.toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).replace(",", "");
  }
