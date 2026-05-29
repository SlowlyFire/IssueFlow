import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Ticket } from '../tickets/ticket.entity';
import { AdminEscalationController } from './admin-escalation.controller';
import { EscalationService } from './escalation.service';

@Module({
  imports: [TypeOrmModule.forFeature([Ticket])],
  controllers: [AdminEscalationController],
  // Guards are provided locally rather than importing AuthModule, which would
  // create a cycle (AuthModule → UsersModule → AuditModule → ...). Neither
  // guard has a service-level dependency on AuthService — they only need
  // Reflector (globally available) and the 'jwt' passport strategy (registered
  // globally when AuthModule initialises elsewhere in the app graph).
  providers: [EscalationService, JwtAuthGuard, RolesGuard],
})
export class SchedulerModule {}
