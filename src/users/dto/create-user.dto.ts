import {
  IsEmail,
  IsEnum,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../common/enums';

export class CreateUserDto {
  @IsString()
  @Length(3, 64)
  @Matches(/^[a-zA-Z0-9_.-]+$/, {
    message:
      'username may only contain letters, digits, underscore, dot, or dash',
  })
  username: string;

  @IsEmail()
  email: string;

  @IsString()
  @Length(1, 200)
  fullName: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsString()
  @MinLength(8)
  password: string;
}
