import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { UsersModule } from '../users/users.module';
import { TicketDependenciesController } from './ticket-dependencies.controller';
import { TicketDependenciesService } from './ticket-dependencies.service';
import { TicketDependency } from './ticket-dependency.entity';
import { Ticket } from './ticket.entity';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ticket, TicketDependency]),
    ProjectsModule, // exports WorkloadService used by auto-assign
    UsersModule,
    AuthModule,
    AuditModule, // exports AuditService used by auto-assign
  ],
  controllers: [TicketsController, TicketDependenciesController],
  providers: [TicketsService, TicketDependenciesService],
  exports: [TicketsService, TicketDependenciesService],
})
export class TicketsModule {}
