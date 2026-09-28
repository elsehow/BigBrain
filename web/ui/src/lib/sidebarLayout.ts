/** Shared app shell state; absent only in legacy comparison workbenches. */
export const SIDEBAR_LAYOUT = Symbol('sidebar-layout');
export interface SidebarLayout {
  documentReturn?: string;
  documentMenu?: { workspaceId: string };
  closeDocument?: () => void;
  conversationMenu?: { workspaceId: string; agentId: string };
  homeMenuResume?: { workspaceId: string; agentId?: string };
  conversationReturn?: string[];
  homePreview?: string | null;
  homeMenuRight?: number;
  homeMenuKey?: (event: KeyboardEvent) => boolean;
  dismissEditor?: () => void;
  listSelection?: string[];
  listAction?: (action: "toggle" | "pilot" | "read" | "first" | "last") => void;
  memoryPreview?: string | null;
  open: boolean;
  tab?: "search" | "agents" | "recents" | "settings" | "document";
  unreadOnly?: boolean;
  openRecents?: () => void;
  openSearch?: () => void;
  agents: boolean;
  searchVisible: boolean;
  expanded: boolean;
  fullscreenChat?: boolean;
  hoverId: string | null;
  goHome?: () => void;
  resetGraph?: () => void;
  presentation?: () => unknown;
  camera?: () => import("./graph/framing").Camera | null;
}
