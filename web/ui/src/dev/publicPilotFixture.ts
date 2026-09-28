import { pilotChatDetail } from "../../../../lib/pilotChatSummary";
import type { PilotChatSession } from "../../../../lib/pilotChatTypes";
import { fullPilotView } from "../lib/pilotChatSync";
export const publicPilotFixture = (session: PilotChatSession) => fullPilotView(pilotChatDetail(session));
