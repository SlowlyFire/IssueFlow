// Pure, framework-free. The mention syntax is `@<username>` where:
//   - `<username>` must START and END with a word character ([A-Za-z0-9_])
//     — that's what eliminates trailing punctuation like `@alice.` or
//     `@alice,` from being captured as part of the name.
//   - INTERNAL dots and dashes are allowed (so `@john.doe`, `@mary-jane`
//     work), matching the username pattern Users registration accepts.
//   - The `@` itself must NOT be preceded by another word character —
//     `(?<!\w)` — which is how `alice@example.com` is correctly NOT
//     treated as a mention of `example.com`. `\w` includes the
//     underscore, so `user_@alice` is also not a mention (consistent
//     rule: an `@` that looks like it's continuing a word is an email
//     fragment, not a mention).
//   - Lookbehind `(?<!\w)` matches at start-of-string, after whitespace,
//     after most punctuation (including `@` itself, so `@@alice` matches
//     `alice` once).
//
// Matching is case-INSENSITIVE for resolution; we lowercase every capture
// before deduping. The output preserves first-seen order.
const MENTION_RE = /(?<!\w)@(\w(?:[\w.-]*\w)?)/g;

export function extractMentions(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(MENTION_RE)) {
    const name = match[1].toLowerCase();
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
