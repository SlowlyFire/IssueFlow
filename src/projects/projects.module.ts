import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { Ticket } from '../tickets/ticket.entity';
import { User } from '../users/user.entity';
import { UsersModule } from '../users/users.module';
import { Project } from './project.entity';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { WorkloadService } from './workload.service';

@Module({
  imports: [
    // Project repo is owned here; Ticket and User are re-registered for the
    // WorkloadService to query without forcing TicketsModule ↔ ProjectsModule
    // to import each other.
    TypeOrmModule.forFeature([Project, Ticket, User]),
    UsersModule,
    AuthModule,
    AuditModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService, WorkloadService],
  // WorkloadService is exported so TicketsService can auto-assign on create
  // (it depends on the same workload query the public endpoint uses).
  exports: [ProjectsService, WorkloadService],
})
export class ProjectsModule {}
