/** Note routing can ask the composition layer whether a path is a conversation. */
let openAlias: (path: string, replace: boolean) => boolean = () => false;
export function configureNoteAliases(open: typeof openAlias): void { openAlias = open; }
export const openConversationAlias = (path: string, replace: boolean) => openAlias(path, replace);
