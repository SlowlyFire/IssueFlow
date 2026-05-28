import * as bcrypt from 'bcrypt';

const ROUNDS = 10;

describe('Password hashing (bcrypt @ rounds=10)', () => {
  it('a hash verifies against its original password', async () => {
    const hash = await bcrypt.hash('correct horse battery staple', ROUNDS);
    expect(await bcrypt.compare('correct horse battery staple', hash)).toBe(true);
  });

  it('a hash does not verify against a different password', async () => {
    const hash = await bcrypt.hash('correct horse battery staple', ROUNDS);
    expect(await bcrypt.compare('wrong password', hash)).toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const a = await bcrypt.hash('same-password', ROUNDS);
    const b = await bcrypt.hash('same-password', ROUNDS);
    expect(a).not.toBe(b);
    expect(await bcrypt.compare('same-password', a)).toBe(true);
    expect(await bcrypt.compare('same-password', b)).toBe(true);
  });

  it('embeds the cost in the hash so it can be inspected', async () => {
    const hash = await bcrypt.hash('x', ROUNDS);
    // bcrypt format: $2b$<rounds>$<salt><hash>
    expect(hash).toMatch(/^\$2[aby]?\$10\$/);
  });
});
