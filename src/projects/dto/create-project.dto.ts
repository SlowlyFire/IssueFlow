import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @Length(1, 200)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(1)
  ownerId: number;
}
