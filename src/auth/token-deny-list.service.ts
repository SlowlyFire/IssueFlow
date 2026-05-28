import { Injectable } from '@nestjs/common';

// In-memory, process-local. Resets on restart — fine for this assignment;
// a real deployment would back this with Redis keyed by jti with TTL equal
// to the token's remaining lifetime.
@Injectable()
export class TokenDenyListService {
  private readonly revokedJtis = new Set<string>();

  revoke(jti: string): void {
    this.revokedJtis.add(jti);
  }

  isRevoked(jti: string): boolean {
    return this.revokedJtis.has(jti);
  }

  size(): number {
    return this.revokedJtis.size;
  }
}
