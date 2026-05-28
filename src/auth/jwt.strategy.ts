import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { TokenDenyListService } from './token-deny-list.service';

interface JwtPayload {
  sub: number;
  username: string;
  role: string;
  jti: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly denyList: TokenDenyListService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload.jti || this.denyList.isRevoked(payload.jti)) {
      throw new UnauthorizedException('Token has been revoked');
    }
    return {
      userId: payload.sub,
      username: payload.username,
      role: payload.role,
      jti: payload.jti,
    };
  }
}
