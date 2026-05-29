import { extractMentions } from './mention-parser';

describe('extractMentions', () => {
  it('returns [] for content with no @ at all', () => {
    expect(extractMentions('plain text, nothing to see')).toEqual([]);
  });

  it('returns [] for empty / whitespace-only input', () => {
    expect(extractMentions('')).toEqual([]);
    expect(extractMentions('   \n\n  ')).toEqual([]);
  });

  it('matches a standalone @alice', () => {
    expect(extractMentions('@alice')).toEqual(['alice']);
  });

  it('matches multiple mentions in one sentence', () => {
    expect(extractMentions('Hey @alice and @bob, take a look')).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('does NOT match emails: alice@example.com', () => {
    expect(extractMentions('contact alice@example.com please')).toEqual([]);
  });

  it('does NOT match @ preceded by an underscore (still a word char)', () => {
    // user_@alice is not a mention — underscore is a word character, so the
    // negative lookbehind blocks it, consistent with the email rule.
    expect(extractMentions('user_@alice')).toEqual([]);
  });

  it('strips trailing punctuation: @alice. → alice', () => {
    expect(extractMentions('Hi @alice. How are you?')).toEqual(['alice']);
  });

  it('strips trailing comma: @alice, → alice', () => {
    expect(extractMentions('cc @alice, @bob')).toEqual(['alice', 'bob']);
  });

  it('strips trailing colon: @alice: → alice', () => {
    expect(extractMentions('@alice: see this')).toEqual(['alice']);
  });

  it('keeps INTERNAL dots and dashes: @john.doe and @mary-jane are usernames', () => {
    expect(extractMentions('@john.doe and @mary-jane')).toEqual([
      'john.doe',
      'mary-jane',
    ]);
  });

  it('deduplicates case-insensitively: @alice and @ALICE → one match (lowercased)', () => {
    expect(extractMentions('@alice and @ALICE and @Alice')).toEqual(['alice']);
  });

  it('handles @@alice (double @): captures alice once', () => {
    // Second @ is preceded by another @ (non-word), so it matches alice.
    // First @ alone has no username following it, so it captures nothing.
    expect(extractMentions('@@alice')).toEqual(['alice']);
  });

  it('handles multiline content', () => {
    const content = `First line mentions @alice.
Second line mentions @bob and ignores plain text.
Third line: @charlie!`;
    expect(extractMentions(content).sort()).toEqual(['alice', 'bob', 'charlie']);
  });

  it('ignores a lone "@" with no following identifier', () => {
    expect(extractMentions('just @ alone')).toEqual([]);
    expect(extractMentions('end with @')).toEqual([]);
    expect(extractMentions('@!nonsense')).toEqual([]);
  });

  it('preserves insertion order in the deduped output', () => {
    expect(extractMentions('@bob hi @alice cc @bob again')).toEqual([
      'bob',
      'alice',
    ]);
  });

  it('handles tabs and other whitespace before @', () => {
    expect(extractMentions('cc:\t@alice')).toEqual(['alice']);
  });
});
