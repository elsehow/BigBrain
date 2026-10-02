/**
 * drop.ts — put an item into the vault from the command line. It lands
 * locally through the same core the doors use (lib/intake.ts).
 *
 * Files come in two shapes (#57):
 *  - TEXT (markdown, plain text): the file IS the item — body + optional
 *    envelope frontmatter, exactly as before.
 *  - BINARY (a PDF, an image, audio — lib/intake.ts's looksBinary): the
 *    file rides as an ATTACHMENT. Original bytes land in the CAS keyed by
 *    sha256; an insertion (title from the filename, kind from the
 *    extension) links `blob:<sha256>`.
 *    Never again the utf8 mangle: bytes are read as bytes.
 *  - Mixed: `drop note.md --attach paper.pdf` attaches files to a text item.
 *
 * Usage:
 *   bun bin/drop.ts note.md                      # land a text item
 *   bun bin/drop.ts paper.pdf                    # land a file as attachment
 *   bun bin/drop.ts note.md --attach paper.pdf   # item + attached files
 *   ... | bun bin/drop.ts                        # or pipe it
 * Flags: --attach <file> (repeatable)
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { FirewallUnavailable, land } from "../lib/door";
import { ensureItemId, IntakeError, looksBinary, type Attachment } from "../lib/intake";
import { discussablePdf } from "../lib/pdfText";
import { flagValues, positionals } from "../lib/cliflags";
import { fmBody, fmRaw, fmSerialize } from "../lib/wire";

const argv = process.argv.slice(2);

// Positional file argument: the first arg that is neither a flag nor a
// flag's value (--attach repeats, so every flag value must be excluded).
// Accept the retired filename flag so old scripts still parse correctly.
const FLAGS_WITH_VALUE = new Set(["name", "attach"]);
const fileArg = positionals(argv, FLAGS_WITH_VALUE)[0];

const attachArgs = flagValues(argv, "attach").filter(Boolean); // an empty --attach "" is dropped, not a "no such file"
for (const p of attachArgs)
  if (!existsSync(p)) {
    console.error(`drop: --attach ${p}: no such file`);
    process.exit(2);
  }

/** Read a file for attachment transport. */
const toAttachment = (path: string): Attachment => ({
  name: basename(path),
  b64: readFileSync(path).toString("base64"),
});

let content: string;
const attachments: Attachment[] = [];

if (fileArg) {
  if (!existsSync(fileArg)) {
    console.error(`drop: ${fileArg}: no such file`);
    process.exit(2);
  }
  const bytes = readFileSync(fileArg);
  if (looksBinary(fileArg, bytes)) {
    // The file IS the payload: original bytes ride as an attachment, and a
    // minimal envelope becomes the item. Title from the filename, kind from
    // the extension — a PDF's text layer and real title are the door's job
    // on landing (lib/pdfText.ts).
    const base = basename(fileArg);
    const ext = base.split(".").at(-1)?.toLowerCase() ?? "file";
    const title = base.replace(/\.[^.]+$/, "");
    // source/kind/date have always shipped unquoted (fmRaw); title is the
    // one quoted field (yq) — a spelling that predates lib/wire.ts, kept
    // byte-for-byte on purpose (test/wire.test.ts's GOLDEN drop.ts case).
    const fm = fmSerialize([
      ["source", fmRaw("cli")],
      ["kind", fmRaw(ext)],
      ["title", title],
      ["date", fmRaw(new Date().toISOString())],
    ]);
    content = fmBody(fm, `Dropped file: ${base} (${bytes.byteLength} bytes)`);
    attachments.push({ name: base, b64: bytes.toString("base64") });
  } else {
    content = bytes.toString("utf8");
  }
} else {
  content = await Bun.stdin.text();
}

if (!content.trim()) {
  console.error("drop: nothing to send — pass a file or pipe the item on stdin");
  process.exit(2);
}

attachments.push(...attachArgs.map(toAttachment));

// Land it directly through the same core the doors use (lib/intake.ts),
// which is also the only local path that can carry attachments into the CAS.
try {
  // A bare PDF drop gets its text layer here, same as at the HTTP door
  // (lib/pdfText.ts, lib/landItem.ts) — before the id stamp, and the
  // composed payload is the dedup identity, as there.
  const discussable = await discussablePdf(content, attachments);
  const receipt = await land({
    root: VAULT_ROOT,
    content: ensureItemId(discussable),
    raw: discussable, // pre-stamp payload — the landing dedup identity
    attachments,
  });
  // The receipt names the immutable event that just landed.
  console.log(
    `drop: landed at ${receipt.path} (source ${receipt.id})`
  );
  process.exit(0);
} catch (e) {
  if (e instanceof IntakeError || e instanceof FirewallUnavailable) {
    console.error(`drop: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
