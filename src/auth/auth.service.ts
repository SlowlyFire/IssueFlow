import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { UsersService } from '../users/users.service';
import { TokenDenyListService } from './token-deny-list.service';

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly denyList: TokenDenyListService,
  ) {}

  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.users.findByUsername(username);
    // Run bcrypt.compare even when the user is missing so timing doesn't
    // disclose username existence. Generic 401 in both branches.
    const passwordOk = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, '$2b$10$invalidsaltinvalidsaltinvalidsaltinvalidsalt');
    if (!user || !passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const expiresIn = Number(this.config.get<string>('JWT_EXPIRES_IN') ?? 3600);
    const jti = randomUUID();
    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
        jti,
      },
      { expiresIn },
    );
    return { accessToken, tokenType: 'Bearer', expiresIn };
  }

  logout(jti: string): void {
    this.denyList.revoke(jti);
  }
}
