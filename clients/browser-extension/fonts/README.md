# Hanken Grotesk

The design system's one typeface (`--font-app`). Self-hosted rather than
pulled from Google Fonts: the popup opens and closes in seconds, so a
network round-trip for the typeface would flash on every open, and every
open would also ping a third party.

Licensed under the [SIL Open Font License 1.1][ofl] — redistribution inside
this extension is exactly what that permits. Upstream:
<https://github.com/marcologous/Hanken-Grotesk>.

[ofl]: https://openfontlicense.org/

These are the **variable** woff2 subsets Google serves for
`css2?family=Hanken+Grotesk:wght@400;500;600` — one file per unicode range
covering the whole 400–600 axis (you can tell it is variable because every
weight in the request resolves to the same URL). The `unicode-range` values
in `fonts.css` are that stylesheet's, verbatim; keep the two in step if you
ever re-fetch.

| file | range |
|---|---|
| `hanken-grotesk-latin.woff2` | latin |
| `hanken-grotesk-latin-ext.woff2` | latin-ext |
| `hanken-grotesk-vietnamese.woff2` | vietnamese |
| `hanken-grotesk-cyrillic-ext.woff2` | cyrillic-ext |

A page title outside these ranges falls back per-glyph to `system-ui`, which
is the right outcome — a captured title stays legible in any script without
the extension carrying every subset.
