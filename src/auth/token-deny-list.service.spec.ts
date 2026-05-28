import { TokenDenyListService } from './token-deny-list.service';

describe('TokenDenyListService', () => {
  let svc: TokenDenyListService;

  beforeEach(() => {
    svc = new TokenDenyListService();
  });

  it('reports a fresh jti as not revoked', () => {
    expect(svc.isRevoked('abc-123')).toBe(false);
  });

  it('reports a revoked jti as revoked', () => {
    svc.revoke('abc-123');
    expect(svc.isRevoked('abc-123')).toBe(true);
  });

  it('only revokes the specific jti, not similar ones', () => {
    svc.revoke('abc-123');
    expect(svc.isRevoked('abc-124')).toBe(false);
    expect(svc.isRevoked('abc-12')).toBe(false);
    expect(svc.isRevoked('')).toBe(false);
  });

  it('is idempotent — revoking the same jti twice does not grow the set', () => {
    svc.revoke('abc-123');
    svc.revoke('abc-123');
    expect(svc.size()).toBe(1);
    expect(svc.isRevoked('abc-123')).toBe(true);
  });
});
