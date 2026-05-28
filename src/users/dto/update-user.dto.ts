import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { UserRole } from '../../common/enums';

// Per the README contract, user update accepts only fullName and role.
// All other fields are intentionally unsupported and the global
// ValidationPipe's forbidNonWhitelisted will reject them.
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  fullName?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
