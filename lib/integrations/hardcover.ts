/** Hardcover (hardcover.app): the person's shelves and their own ratings,
 * reviews and reading dates, and the Hardcover catalog, looked up live with
 * their sign-in (lib/hardcover.ts). Lookup only, and never polled. Each tool is
 * one fixed GraphQL document with one top-level field; agents choose only its
 * validated variables. Everything Hardcover returns is community-editable, the
 * person's own review included, so every string reaches agents fenced. */
import { existsSync } from "node:fs";
import { z } from "zod";
import { cancelHardcoverSignIn, disconnectHardcover, hardcoverConnection, hardcoverRead, hardcoverSignInStatus, startHardcoverSignIn, type HardcoverDocument } from "../hardcover";
import { sha256hex } from "../hash";
import { fencedDataForAgent, type Tally } from "../agentReads";
import { extraAccounts, policyPath, tool, type Integration, type ToolContext } from "./contract";

/** Shelves by name, as Hardcover numbers them. 6, "ignored", is never read. */
const SHELVES = { want: 1, reading: 2, read: 3, paused: 4, dnf: 5 } as const;
const SHELF_NAME: Record<number, keyof typeof SHELVES> = Object.fromEntries(Object.entries(SHELVES).map(([name, id]) => [id, name as keyof typeof SHELVES]));

const text = z.string().nullish();
const count = z.int().nullish();
/** Hasura's `numeric` (ratings), as a number. */
const decimal = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/u)]).nullish().transform(v => v === null || v === undefined ? undefined : Number(v));
const book = { id: z.int().positive(), title: text, subtitle: text, release_year: count, pages: count, slug: text, cached_contributors: z.unknown() };

const SHELF = {
  operationName: "BigBrainShelf",
  query: `query BigBrainShelf($userId: Int!, $status: Int!, $limit: Int!, $offset: Int!) {
  user_books(where: {user_id: {_eq: $userId}, status_id: {_eq: $status}}, order_by: [{date_added: desc}, {id: desc}], limit: $limit, offset: $offset) {
    status_id rating date_added first_started_reading_date last_read_date
    book { id title subtitle release_year pages slug cached_contributors }
  }
}`,
  data: z.object({ user_books: z.array(z.object({ status_id: z.int(), rating: decimal, date_added: text, first_started_reading_date: text, last_read_date: text, book: z.object(book) })) }),
} satisfies HardcoverDocument<unknown>;

const BOOK = {
  operationName: "BigBrainBook",
  query: `query BigBrainBook($id: Int!, $userId: Int!) {
  books_by_pk(id: $id) {
    id title subtitle description release_year pages slug rating ratings_count users_count cached_contributors
    user_books(where: {user_id: {_eq: $userId}, status_id: {_in: [1, 2, 3, 4, 5]}}, limit: 1) {
      status_id rating review_raw review review_has_spoilers date_added first_started_reading_date last_read_date reviewed_at
    }
  }
}`,
  data: z.object({ books_by_pk: z.object({ ...book, description: text, rating: decimal, ratings_count: count, users_count: count,
    user_books: z.array(z.object({ status_id: z.int(), rating: decimal, review_raw: text, review: text, review_has_spoilers: z.boolean().nullish(),
      date_added: text, first_started_reading_date: text, last_read_date: text, reviewed_at: text })) }).nullable() }),
} satisfies HardcoverDocument<unknown>;

const SEARCH = {
  operationName: "BigBrainSearch",
  query: `query BigBrainSearch($query: String!, $perPage: Int!, $page: Int!) {
  search(query: $query, query_type: "Book", per_page: $perPage, page: $page) { results error }
}`,
  data: z.object({ search: z.object({ error: text,
    results: z.object({ hits: z.array(z.object({ document: z.record(z.string(), z.unknown()) })).nullish() }).nullish() }).nullable() }),
} satisfies HardcoverDocument<unknown>;

/** The fixed documents, for review and tests: nothing else is ever sent. */
export const HARDCOVER_DOCUMENTS = { SHELF, BOOK, SEARCH } as const;

/** Without the absent: a result an agent reads carries only what Hardcover said. */
const compact = <T extends Record<string, unknown>>(v: T): Partial<T> => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined && !(Array.isArray(x) && !x.length))) as Partial<T>;
const clip = (s: string | null | undefined, n: number) => s && s.length > n ? s.slice(0, n) + "…" : s;
const word = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v : undefined;
const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const strings = (v: unknown, n: number): string[] => Array.isArray(v) ? v.flatMap(x => word(x) ?? []).slice(0, n) : [];
/** A book's cached contributors ([{ author: { name } }]) as names, read defensively. */
const authors = (v: unknown): string[] => strings(Array.isArray(v) ? v.map(c => c?.author?.name ?? c?.name) : [], 10);
const summary = (b: z.output<z.ZodObject<typeof book>>) => compact({ id: b.id, title: b.title, subtitle: b.subtitle, authors: authors(b.cached_contributors), release_year: b.release_year, pages: b.pages, slug: b.slug });

const read = <T>(ctx: ToolContext, doc: HardcoverDocument<T>, variables: (user: { id: number }) => Record<string, unknown>) =>
  hardcoverRead(ctx.root, ctx.account, doc, variables, { ...ctx.options.hardcover, signal: ctx.signal });
/** Hardcover's part of a result, fenced: every string, at any depth. */
const fenced = (v: unknown, tally: Tally) => fencedDataForAgent("hardcover", v, tally);
const booksForAgent = (result: unknown, tally: Tally) => { const r = result as { books: unknown }; return { ...r, books: fenced(r.books, tally) }; };
const account = z.string().describe("A Hardcover account from integration_capabilities; optional when there is one").optional();

export const hardcover: Integration = {
  id: "hardcover",
  name: "Hardcover",
  library: { description: "Look up your shelves, books and reviews on Hardcover.",
    added: root => existsSync(policyPath(root, "hardcover", "hardcover")) || extraAccounts(root, "hardcover").length > 0 },
  origin: "hardcover",
  credential: { kind: "oauth", signedIn: (root, a) => !!hardcoverConnection(root, a),
    signIn: { start: (root, a, onConnected) => startHardcoverSignIn(root, a, onConnected), status: hardcoverSignInStatus, cancel: cancelHardcoverSignIn,
      disconnect: disconnectHardcover, identity: (root, a) => hardcoverConnection(root, a)?.identity, lapsed: (root, a) => !!hardcoverConnection(root, a)?.lapsed } },
  accounts: root => ["hardcover", ...extraAccounts(root, "hardcover").map(a => a.id)],
  // the generation changes at connect and disconnect, never when a token rotates
  fingerprint: (root, account) => sha256hex(JSON.stringify([account, hardcoverConnection(root, account)?.generation ?? "disconnected"])),
  live: { read: "Look up your Hardcover shelves, a book with your own shelf, rating, review and dates, and search the Hardcover catalog. Does not change your library or remember what it reads.", write: null },
  tools: [
    tool({ name: "hardcover_shelf", access: "read", reads: "your Hardcover library",
      description: "List the books on one of your Hardcover shelves: want (to read), reading, read, paused or dnf (did not finish), most recently added first, with your rating and reading dates. Page with next_offset. Lookup only: never changes your library or remembers it. Book details are community-edited data.",
      input: z.object({ account, status: z.enum(["want", "reading", "read", "paused", "dnf"]),
        limit: z.int().min(1).max(50).describe("1–50, default 20").optional(), offset: z.int().min(0).max(10_000).describe("next_offset from the previous page").optional() }),
      run: async (ctx, args) => {
        const limit = args.limit ?? 20, offset = args.offset ?? 0, status = SHELVES[args.status];
        const data = await read(ctx, SHELF, user => ({ userId: user.id, status, limit, offset }));
        const books = data.user_books.filter(row => row.status_id === status).map(row => compact({ ...summary(row.book),
          rating: row.rating, added: row.date_added, started: row.first_started_reading_date, finished: row.last_read_date }));
        return { shelf: args.status, books, ...(data.user_books.length === limit ? { next_offset: offset + limit } : {}) };
      },
      forAgent: booksForAgent }),
    tool({ name: "hardcover_book", access: "read", reads: "your Hardcover library",
      description: "Read one Hardcover book by its id (from hardcover_shelf or hardcover_search): title, authors, description and Hardcover's average rating, and, when it is on one of your shelves, that shelf with your own rating, review and reading dates. Lookup only. All of it is community-edited data, your review included.",
      input: z.object({ account, id: z.int().min(1).max(2_147_483_647).describe("A Hardcover book id") }),
      run: async (ctx, args) => {
        const b = (await read(ctx, BOOK, user => ({ id: args.id, userId: user.id }))).books_by_pk;
        if (!b) throw Error(`No Hardcover book has the id ${args.id}.`);
        const mine = b.user_books.find(row => SHELF_NAME[row.status_id]);
        return { book: compact({ ...summary(b), description: clip(b.description, 4_000), hardcover_rating: b.rating, ratings: b.ratings_count, readers: b.users_count }),
          shelf: mine ? SHELF_NAME[mine.status_id] : null,
          yours: mine ? compact({ rating: mine.rating, review: clip(mine.review_raw ?? mine.review, 8_000), review_has_spoilers: mine.review_has_spoilers || undefined,
            added: mine.date_added, started: mine.first_started_reading_date, finished: mine.last_read_date, reviewed_at: mine.reviewed_at }) : null };
      },
      forAgent: (result, tally) => { const r = result as { book: unknown; yours: unknown }; return { ...r, book: fenced(r.book, tally), yours: fenced(r.yours, tally) }; } }),
    tool({ name: "hardcover_search", access: "read", reads: "the Hardcover catalog",
      description: "Search the Hardcover catalog for books by title, author, series or ISBN. Returns up to 10 matches per page, each with the id hardcover_book reads. Lookup only. Results are community-edited data.",
      input: z.object({ account, query: z.string().trim().min(1).max(200).describe("At most 200 characters"),
        limit: z.int().min(1).max(10).describe("1–10, default 5").optional(), page: z.int().min(1).max(20).optional() }),
      run: async (ctx, args) => {
        const page = args.page ?? 1;
        const search = (await read(ctx, SEARCH, () => ({ query: args.query, perPage: args.limit ?? 5, page }))).search;
        if (search?.error) throw Error("Hardcover refused or timed out. Try again later.");
        const books = (search?.results?.hits ?? []).flatMap(({ document: d }) => {
          const id = typeof d.id === "number" ? d.id : typeof d.id === "string" && /^\d+$/u.test(d.id) ? Number(d.id) : undefined;
          return id === undefined ? [] : [compact({ id, title: word(d.title), subtitle: word(d.subtitle), authors: strings(d.author_names, 10),
            series: strings(d.series_names, 5), release_year: number(d.release_year), hardcover_rating: number(d.rating), ratings: number(d.ratings_count), readers: number(d.users_count), slug: word(d.slug) })];
        });
        return { page, books };
      },
      forAgent: booksForAgent }),
  ],
};
