import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import {
  EscalationCycleSummary,
  EscalationService,
} from './escalation.service';

// Manual trigger for demonstration and testing. The cron runs automatically
// on the schedule configured by ESCALATION_CRON (default: every 15 minutes).
// This endpoint lets a reviewer trigger an immediate cycle without waiting.
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminEscalationController {
  constructor(private readonly escalation: EscalationService) {}

  @Post('escalate-now')
  @HttpCode(HttpStatus.OK)
  escalateNow(): Promise<EscalationCycleSummary> {
    return this.escalation.runEscalationCycle();
  }
}
