// markdown.js — the house Turndown rules, defined here (an IIFE hanging
// BigBrainMarkdown off globalThis, the slug.js shape) so extract.js can
// use them in the page and a test can import them without a DOM.
//
// One rule so far. An anchor wrapped around BLOCK content is legal HTML and
// common — Substack's byline is <a><div><img avatar></div><div>Name</div></a>,
// and every card / tile / "read more" link is the same shape — but Turndown
// converts it as an inline link regardless: "[", then the blocks' own
// paragraph breaks, then "](url)". The "[" lands alone on a line, and the
// note opens with a bracket (2026-08-27, "On Writing #3"). The fix is not to
// drop the link: collapse a short one onto one line (images inside a link
// are fine markdown), and for a long one keep the blocks and put the href
// after them, once, where a reader can still follow it.

(() => {
  const BLOCK = "p, div, h1, h2, h3, h4, h5, h6, ul, ol, li, table, blockquote, section, article, figure, header, footer, pre, hr";

  /** Longest link text still worth keeping inline; past it, the blocks stay. */
  const INLINE_MAX = 200;

  const hasBlockChild = (node) => typeof node.querySelector === "function" && node.querySelector(BLOCK) !== null;

  /** Turndown's own `a` rule wants the href unescaped; the title is kept
   * only when present, as it does. */
  const href = (node) => (node.getAttribute("href") || "").trim();

  const rules = {
    blockLink: {
      filter: (node) => node.nodeName === "A" && href(node) !== "" && hasBlockChild(node),
      replacement: (content, node) => {
        const url = href(node);
        const text = content.trim();
        if (!text) return "";
        const line = text.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
        // block markers turned inline would read as noise ("## Title - one - two")
        const blocky = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|)/.test(text);
        if (line.length <= INLINE_MAX && !blocky) return `[${line}](${url})`;
        return `${text}\n\n<${url}>`;
      },
    },
  };

  globalThis.BigBrainMarkdown = {
    rules,
    /** Register every rule on a TurndownService. Added rules outrank the
     * defaults, so `a` with block children lands here, not in Turndown's. */
    configure(td) {
      for (const [name, rule] of Object.entries(rules)) td.addRule(name, rule);
      return td;
    },
  };
})();
