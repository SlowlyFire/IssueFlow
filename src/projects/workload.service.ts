import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TicketStatus, UserRole } from '../common/enums';
import { Ticket } from '../tickets/ticket.entity';
import { User } from '../users/user.entity';
import { Project } from './project.entity';

export interface WorkloadEntry {
  userId: number;
  username: string;
  openTicketCount: number;
}

// Lives in projects module rather than tickets module because the public
// endpoint is GET /projects/:id/workload AND because TicketsModule already
// imports ProjectsModule — putting workload in tickets would force a
// forwardRef. The service depends on Ticket, User, Project entities
// directly (via @InjectRepository) so no module-to-module coupling is
// introduced.
//
// Assumption (no project-membership concept in the README): "DEVELOPERs in
// the project" means "all DEVELOPERs in the system". Their workload is
// scoped to the project, but their eligibility is global. Devs with zero
// non-DONE tickets in the project are included (they're the strongest
// auto-assign candidates).
@Injectable()
export class WorkloadService {
  constructor(
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
  ) {}

  // Public endpoint version: validates the project exists, returns all
  // DEVELOPERs sorted by open-count ASC then createdAt ASC then id ASC.
  async getWorkloadForProject(projectId: number): Promise<WorkloadEntry[]> {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return this.computeWorkload(projectId);
  }

  // Auto-assign caller: skips project validation because TicketsService
  // already did it. Returns the userId of the first developer in the
  // sorted workload list, or null if there are no DEVELOPERs.
  async pickAutoAssignee(projectId: number): Promise<number | null> {
    const workload = await this.computeWorkload(projectId);
    return workload.length > 0 ? workload[0].userId : null;
  }

  // ── Internal ────────────────────────────────────────────────────────────────
  // LEFT JOIN so DEVELOPERs with zero matching tickets still appear with
  // openTicketCount = 0. Filters on the JOIN (NOT a WHERE on t.*) so the
  // zeros don't get dropped by the LEFT side.
  private async computeWorkload(projectId: number): Promise<WorkloadEntry[]> {
    const rows = await this.users
      .createQueryBuilder('u')
      .leftJoin(
        Ticket,
        't',
        't.assigneeId = u.id AND t.projectId = :projectId AND t.status != :done AND t.deletedAt IS NULL',
        { projectId, done: TicketStatus.DONE },
      )
      .where('u.role = :role', { role: UserRole.DEVELOPER })
      .groupBy('u.id')
      .addGroupBy('u.username')
      .addGroupBy('u.createdAt')
      .select('u.id', 'userId')
      .addSelect('u.username', 'username')
      .addSelect('COUNT(t.id)', 'openTicketCount')
      .orderBy('COUNT(t.id)', 'ASC')
      .addOrderBy('u.createdAt', 'ASC')
      .addOrderBy('u.id', 'ASC')
      .getRawMany<{
        userId: number;
        username: string;
        openTicketCount: string; // pg COUNT comes back as a string
      }>();

    return rows.map((r) => ({
      userId: Number(r.userId),
      username: r.username,
      openTicketCount: Number(r.openTicketCount),
    }));
  }
}
