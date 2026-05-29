import { IsInt, IsString, Length, Min } from 'class-validator';

export class CreateCommentDto {
  @IsString()
  @Length(1, 10_000)
  content: string;

  @IsInt()
  @Min(1)
  authorId: number;
}
