/** Retransmit a lost HTTP response with the same application identity. A new click
 * is a new request; provider uncertainty is shown and never automatically replayed. */
export async function deliverAction<T>(send: (actionId: string) => Promise<T>): Promise<T> {
  const actionId = crypto.randomUUID();
  try { return await send(actionId); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error; // fetch network errors only, not server refusals
    return send(actionId);
  }
}
