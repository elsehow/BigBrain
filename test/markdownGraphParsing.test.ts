import { expect, test } from "bun:test";
import { explicitNoteLinks } from "../lib/markdownGraph";
import { maskFences } from "../lib/linkSyntax";

/** The prior matcher is an independent oracle for small adversarial strings.
 * Keep it here, not on the production path through large source bodies. */
function previousInlineTargets(text: string): string[] {
  const labels = /(?<!!)\[([^\][]*)\]\(/g;
  const destination = /\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/y;
  const targets: string[] = [];
  while (labels.exec(text)) {
    destination.lastIndex = labels.lastIndex;
    const target = destination.exec(text);
    if (!target) continue;
    targets.push(target[1]!); labels.lastIndex = destination.lastIndex;
  }
  return targets;
}

test("single-pass inline links preserve the old matcher on malformed and nested brackets", () => {
  const examples = [
    '[label](target) ![image](ignored) [](empty-label)',
    '[outer [inner](target)](other)',
    '[broken]( [valid](target)',
    '[title](<a[b]>) [other](target "quoted title")',
    '[multiline\nlabel](target) [bad] text](other)',
    '[[wiki]] [bad]( ) [good](target) !![image](ignored)',
  ];
  const atoms = ['[', ']', '(', ')', 'a', ' ', '!', '<', '>', '"', '/', '\n', '[ok](target)', '[broken]( ', '![image](skip)'];
  let seed = 42;
  for (let sample = 0; sample < 500; sample++) {
    let text = '';
    for (let i = 0; i < 80; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += atoms[seed % atoms.length]; }
    examples.push(text);
  }
  for (const body of examples) {
    const links = explicitNoteLinks({ id: 'document', path: 'memory/test.md', title: 'Test', body },
      (target, _from, markdown) => markdown ? target : undefined);
    expect(links.map(link => link.target)).toEqual(previousInlineTargets(body));
  }
});

test("shared fence masking preserves code exclusion, reference links, and evidence offsets", () => {
  const body = 'Intro.\n\n[Visible](target) and ` [inline](hidden) `.\n\n```md\n[fenced](hidden)\n```\n\n[reference][ref]\n\n[ref]: target';
  const doc = { id: 'document', path: 'memory/test.md', title: 'Test', body };
  const resolve = (target: string) => target === 'target' ? target : undefined;
  const links = explicitNoteLinks(doc, resolve, maskFences(body));
  expect(links).toEqual(explicitNoteLinks(doc, resolve));
  expect(links).toHaveLength(2);
  expect(links[0]!.evidence.text).toBe('[Visible](target) and ` [inline](hidden) `.');
  expect(links[1]!.evidence.text).toBe('[reference][ref]');
});
