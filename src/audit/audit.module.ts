import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AuditController } from './audit.controller';
import { AuditLog } from './audit-log.entity';
import { AuditService } from './audit.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  controllers: [AuditController],
  // Guards are provided locally rather than importing AuthModule, which
  // would create a cycle (AuthModule already imports UsersModule, and
  // UsersService now injects AuditService). The guards have no service-
  // level deps on AuthService — JwtAuthGuard and RolesGuard only need
  // Reflector (provided globally by @nestjs/core), and the 'jwt'
  // passport strategy is registered globally when AuthModule itself
  // initializes elsewhere in the app graph.
  providers: [AuditService, JwtAuthGuard, RolesGuard],
  exports: [AuditService],
})
export class AuditModule {}
