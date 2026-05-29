import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { actorFrom } from '../audit/actor';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import {
  CommentsService,
  CommentWithMentions,
} from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

// Sets the ETag header to "<version>" so clients have a fresh value for
// the next If-Match on PATCH.
function setEtag(res: Response, c: CommentWithMentions): void {
  res.setHeader('ETag', `"${c.version}"`);
}

@Controller('tickets/:ticketId/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CommentWithMentions> {
    const c = await this.comments.create(ticketId, dto, actorFrom(user));
    setEtag(res, c);
    return c;
  }

  @Get()
  list(
    @Param('ticketId', ParseIntPipe) ticketId: number,
  ): Promise<CommentWithMentions[]> {
    return this.comments.findByTicket(ticketId);
  }

  @Patch(':commentId')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() dto: UpdateCommentDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CommentWithMentions> {
    const c = await this.comments.update(
      ticketId,
      commentId,
      dto,
      ifMatch,
      actorFrom(user),
    );
    setEtag(res, c);
    return c;
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('commentId', ParseIntPipe) commentId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.comments.remove(ticketId, commentId, actorFrom(user));
  }
}
