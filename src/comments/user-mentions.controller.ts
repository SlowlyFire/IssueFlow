import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  CommentsService,
  PaginatedComments,
} from './comments.service';
import { QueryUserMentionsDto } from './dto/query-user-mentions.dto';

// Separate controller because the URL is /users/:userId/mentions but the
// domain is comments. Sits in the comments module to avoid pulling
// CommentsService into UsersController. The README's mentions response is
// { data, total, page } per CLAUDE.md — `limit` is intentionally NOT in
// the response (the request uses `pageSize`, which is the client's chosen
// page size; the response echoes the requested page only).
@Controller('users/:userId/mentions')
export class UserMentionsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  list(
    @Param('userId', ParseIntPipe) userId: number,
    @Query() q: QueryUserMentionsDto,
  ): Promise<PaginatedComments> {
    return this.comments.findMentionsForUser(userId, q.page, q.pageSize);
  }
}
