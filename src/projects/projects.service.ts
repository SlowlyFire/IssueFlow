import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ActorContext } from '../audit/actor';
import { AuditActions, AuditEntityTypes } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { Project } from './project.entity';

// ─── Soft-delete pattern (mirrors tickets; keep in sync) ──────────────────────
// Standard reads: TypeORM automatically adds WHERE "deletedAt" IS NULL for
// any entity with @DeleteDateColumn — no manual filtering needed.
// Admin "list deleted": find({ withDeleted: true, where: { deletedAt: Not(IsNull()) } })
// Admin "restore": repository.restore(id) clears deletedAt.
//
// Audit: every state-changing method takes an ActorContext and emits a
// record AFTER the DB write succeeds (so a thrown error never leaves a
// half-truth in the log).
// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateProjectDto, actor: ActorContext): Promise<Project> {
    await this.users.findOne(dto.ownerId);
    const project = this.projects.create({
      name: dto.name,
      description: dto.description ?? null,
      ownerId: dto.ownerId,
    });
    const saved = await this.projects.save(project);
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.PROJECT_CREATE,
      entityType: AuditEntityTypes.PROJECT,
      entityId: saved.id,
      after: saved,
    });
    return saved;
  }

  findAll(): Promise<Project[]> {
    return this.projects.find({ order: { id: 'ASC' } });
  }

  async findOne(id: number): Promise<Project> {
    const project = await this.projects.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }
    return project;
  }

  async update(
    id: number,
    dto: UpdateProjectDto,
    actor: ActorContext,
  ): Promise<void> {
    const project = await this.findOne(id);
    // Snapshot pre-mutation. Shallow clone is enough — Project has no
    // nested objects worth deep-cloning, and the AuditService runs the
    // snapshot through instanceToPlain which produces an independent copy.
    const before = { ...project };
    if (dto.name !== undefined) project.name = dto.name;
    if (dto.description !== undefined) project.description = dto.description;
    const saved = await this.projects.save(project);
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.PROJECT_UPDATE,
      entityType: AuditEntityTypes.PROJECT,
      entityId: id,
      before,
      after: saved,
    });
  }

  async softDelete(id: number, actor: ActorContext): Promise<void> {
    const project = await this.findOne(id);
    const before = { ...project };
    // softRemove mutates the entity in place: deletedAt is now a Date.
    const removed = await this.projects.softRemove(project);
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.PROJECT_DELETE,
      entityType: AuditEntityTypes.PROJECT,
      entityId: id,
      before,
      // For soft delete, after is the post-mutation snapshot (deletedAt set)
      // — not null. Reviewers can see when it was deleted.
      after: removed,
    });
  }

  // ADMIN-only ─────────────────────────────────────────────────────────────────

  listDeleted(): Promise<Project[]> {
    return this.projects.find({
      withDeleted: true,
      where: { deletedAt: Not(IsNull()) },
      order: { deletedAt: 'DESC' },
    });
  }

  async restore(id: number, actor: ActorContext): Promise<void> {
    const project = await this.projects.findOne({
      withDeleted: true,
      where: { id, deletedAt: Not(IsNull()) },
    });
    if (!project) {
      throw new NotFoundException(
        `Soft-deleted project ${id} not found`,
      );
    }
    const before = { ...project };
    await this.projects.restore(id);
    const restored = await this.findOne(id);
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.PROJECT_RESTORE,
      entityType: AuditEntityTypes.PROJECT,
      entityId: id,
      before,
      after: restored,
    });
  }
}
