/** Workbench fixtures omit only the durable deduplication key. */
export type PilotNotification = Omit<import("../../../../lib/pilotNotifications").PilotNotification, "key">;

/** Presentation shared by durable Pilot requests and worker announcements. */
export type NotificationItem = Pick<PilotNotification, "id" | "pilotId" | "pilotTitle" | "text" | "at" | "seen" | "kind" | "dismissed" | "resolved">;
