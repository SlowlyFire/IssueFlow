import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { instanceToPlain } from 'class-transformer';
import { Repository } from 'typeorm';
import { ActorType } from '../common/enums';
import { AuditAction, AuditEntityType } from './audit-actions';
import { AuditLog } from './audit-log.entity';

export interface AuditRecord {
  actorType: ActorType;
  actorId: number | null;
  action: AuditAction | string;
  entityType: AuditEntityType | string;
  entityId: number;
  // Callers may pass an entity instance OR a plain object. The service
  // runs instanceToPlain (which respects @Exclude on the entity) and then
  // applies a hardcoded sanitize step keyed on entityType — belt-and-
  // suspenders so a passwordHash can never land in an audit row even if
  // an entity ever loses its @Exclude.
  before?: unknown;
  after?: unknown;
}

export interface AuditQuery {
  entityType?: string;
  entityId?: number;
  action?: string;
  // "actor" in the public query param is the actor id (per README docs).
  actorId?: number;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}

export interface AuditQueryResult {
  data: AuditLog[];
  total: number;
  page: number;
  limit: number;
}

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
      beforeJson: this.snapshot(r.entityType, r.before),
      afterJson: this.snapshot(r.entityType, r.after),
    });
  }

  async query(q: AuditQuery): Promise<AuditQueryResult> {
    const qb = this.logs
      .createQueryBuilder('a')
      .orderBy('a.createdAt', 'DESC')
      .skip((q.page - 1) * q.limit)
      .take(q.limit);

    if (q.entityType !== undefined) {
      qb.andWhere('a.entityType = :et', { et: q.entityType });
    }
    if (q.entityId !== undefined) {
      qb.andWhere('a.entityId = :eid', { eid: q.entityId });
    }
    if (q.action !== undefined) {
      qb.andWhere('a.action = :act', { act: q.action });
    }
    if (q.actorId !== undefined) {
      qb.andWhere('a.actorId = :aid', { aid: q.actorId });
    }
    if (q.from !== undefined) {
      qb.andWhere('a.createdAt >= :from', { from: q.from });
    }
    if (q.to !== undefined) {
      qb.andWhere('a.createdAt <= :to', { to: q.to });
    }

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page: q.page, limit: q.limit };
  }

  // ── Internal ────────────────────────────────────────────────────────────────
  // Normalise the snapshot once and apply per-entity-type stripping.
  // instanceToPlain respects @Exclude on entity classes (so User.passwordHash
  // is already gone for entity inputs), and is a no-op for plain objects.
  // The entityType-keyed strip below is the second line of defense.
  private snapshot(
    entityType: string,
    snapshot: unknown,
  ): Record<string, unknown> | null {
    if (snapshot === undefined || snapshot === null) return null;
    const plain = instanceToPlain(snapshot) as Record<string, unknown>;
    if (entityType === 'User' && 'passwordHash' in plain) {
      delete plain.passwordHash;
    }
    return plain;
  }
}
