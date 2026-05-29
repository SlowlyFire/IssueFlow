import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { AuditQueryResult, AuditService } from './audit.service';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';

@Controller('audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() q: QueryAuditLogsDto): Promise<AuditQueryResult> {
    return this.audit.query({
      entityType: q.entityType,
      entityId: q.entityId,
      action: q.action,
      actorId: q.actor,
      from: q.from,
      to: q.to,
      page: q.page,
      limit: q.limit,
    });
  }
}
