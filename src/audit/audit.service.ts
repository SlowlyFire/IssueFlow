import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActorType } from '../common/enums';
import { AuditLog } from './audit-log.entity';

export interface AuditRecord {
  actorType: ActorType;
  actorId: number | null;
  action: string;
  entityType: string;
  entityId: number;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

// One-method service used by state-changing operations. Session 5 wires
// only AUTO_ASSIGN (system actor); Session 6 will retrofit the rest of
// the create/update/delete paths and add GET /audit-logs.
@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly logs: Repository<AuditLog>,
  ) {}

  async record(r: AuditRecord): Promise<void> {
    await this.logs.insert({
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      beforeJson: r.before ?? null,
      afterJson: r.after ?? null,
    });
  }
}
