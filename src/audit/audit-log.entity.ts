import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ActorType } from '../common/enums';

@Entity('audit_logs')
@Index(['entityType', 'entityId'])
@Index(['action'])
@Index(['actorType', 'actorId'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'enum', enum: ActorType })
  actorType: ActorType;

  @Column({ type: 'int', nullable: true })
  actorId: number | null;

  @Column({ type: 'varchar', length: 50 })
  action: string;

  @Column({ type: 'varchar', length: 50 })
  entityType: string;

  @Column({ type: 'int' })
  entityId: number;

  @Column({ type: 'jsonb', nullable: true })
  beforeJson: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  afterJson: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
