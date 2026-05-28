import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Comment } from './comment.entity';
import { Mention } from './mention.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Comment, Mention])],
})
export class CommentsModule {}
