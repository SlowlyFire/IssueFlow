import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { Project } from './project.entity';

// ─── Soft-delete pattern (mirrors tickets; keep in sync) ──────────────────────
// Standard reads: TypeORM automatically adds WHERE "deletedAt" IS NULL for
// any entity with @DeleteDateColumn — no manual filtering needed.
// Admin "list deleted": find({ withDeleted: true, where: { deletedAt: Not(IsNull()) } })
// Admin "restore": repository.restore(id) clears deletedAt.
// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
    private readonly users: UsersService,
  ) {}

  async create(dto: CreateProjectDto): Promise<Project> {
    // Validates the owner exists; throws 404 if not.
    await this.users.findOne(dto.ownerId);
    const project = this.projects.create({
      name: dto.name,
      description: dto.description ?? null,
      ownerId: dto.ownerId,
    });
    return this.projects.save(project);
  }

  findAll(): Promise<Project[]> {
    // TypeORM hides soft-deleted rows automatically (WHERE deletedAt IS NULL).
    return this.projects.find({ order: { id: 'ASC' } });
  }

  async findOne(id: number): Promise<Project> {
    // Standard findOne also excludes soft-deleted rows by default.
    const project = await this.projects.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }
    return project;
  }

  async update(id: number, dto: UpdateProjectDto): Promise<void> {
    const project = await this.findOne(id);
    if (dto.name !== undefined) project.name = dto.name;
    if (dto.description !== undefined) project.description = dto.description;
    await this.projects.save(project);
  }

  async softDelete(id: number): Promise<void> {
    const project = await this.findOne(id);
    await this.projects.softRemove(project);
  }

  // ADMIN-only ─────────────────────────────────────────────────────────────────

  listDeleted(): Promise<Project[]> {
    return this.projects.find({
      withDeleted: true,
      where: { deletedAt: Not(IsNull()) },
      order: { deletedAt: 'DESC' },
    });
  }

  async restore(id: number): Promise<void> {
    // Confirm the project exists and is actually soft-deleted.
    const project = await this.projects.findOne({
      withDeleted: true,
      where: { id, deletedAt: Not(IsNull()) },
    });
    if (!project) {
      throw new NotFoundException(
        `Soft-deleted project ${id} not found`,
      );
    }
    await this.projects.restore(id);
  }
}
