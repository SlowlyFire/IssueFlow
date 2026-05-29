import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { Ticket } from '../tickets/ticket.entity';
import { User } from '../users/user.entity';
import { Comment } from './comment.entity';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { Mention } from './mention.entity';
import { UserMentionsController } from './user-mentions.controller';

@Module({
  imports: [
    // Comment + Mention are owned here; User + Ticket are re-registered for
    // direct repo access (existence checks + JOIN to user info for the
    // embedded mentionedUsers) without forcing module-level dependencies
    // on UsersModule or TicketsModule.
    TypeOrmModule.forFeature([Comment, Mention, User, Ticket]),
    AuditModule,
  ],
  controllers: [CommentsController, UserMentionsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
