import { IsOptional, IsString, Length } from 'class-validator';

// Per README contract: PATCH /projects/:id accepts only name and description.
export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
