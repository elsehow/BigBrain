import type { SourceReadState } from '../../../../lib/sourceReadStateTypes';
import type { SearchHitLike } from './omnibox';
import type { ResultPage } from './pagedSearch';

/** Continue beyond nonmatching raw pages; the returned cursor is a raw offset,
 * not the number of unread matches. Each scan owns one read-index snapshot. */
export async function scanUnreadPage<H extends SearchHitLike>(
  fetchPage: (offset: number, signal: AbortSignal) => Promise<ResultPage<H>>,
  readStates: ReadonlyMap<string, SourceReadState>, offset: number, signal: AbortSignal, minimum = 50,
): Promise<ResultPage<H>> {
  const hits: H[] = [];
  let next: number | null = offset;
  do {
    signal.throwIfAborted();
    const page = await fetchPage(next, signal);
    signal.throwIfAborted();
    hits.push(...page.hits.filter(hit => readStates.get(hit.note.path)?.unread === true));
    next = page.nextOffset;
  } while (next !== null && hits.length < minimum);
  return { hits, nextOffset: next };
}
