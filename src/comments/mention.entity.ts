import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('mentions')
@Unique(['commentId', 'mentionedUserId'])
@Index(['mentionedUserId'])
export class Mention {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  commentId: number;

  @Column({ type: 'int' })
  mentionedUserId: number;

  @CreateDateColumn()
  createdAt: Date;
}
