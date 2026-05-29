import { IsString, Length } from 'class-validator';

// Per the README contract: PATCH /tickets/:ticketId/comments/:commentId
// accepts only `content`. authorId, version, etc. are off-limits — the
// global forbidNonWhitelisted rejects them.
export class UpdateCommentDto {
  @IsString()
  @Length(1, 10_000)
  content: string;
}
