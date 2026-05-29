import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { actorFrom } from '../audit/actor';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { TicketDependenciesService } from './ticket-dependencies.service';
import { Ticket } from './ticket.entity';

class AddDependencyDto {
  @IsInt()
  @Min(1)
  blockedBy: number;
}

@Controller('tickets/:ticketId/dependencies')
export class TicketDependenciesController {
  constructor(private readonly deps: TicketDependenciesService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  add(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: AddDependencyDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.deps.addDependency(ticketId, dto.blockedBy, actorFrom(user));
  }

  @Get()
  list(
    @Param('ticketId', ParseIntPipe) ticketId: number,
  ): Promise<Ticket[]> {
    return this.deps.listDependencies(ticketId);
  }

  @Delete(':blockerId')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('blockerId', ParseIntPipe) blockerId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.deps.removeDependency(ticketId, blockerId, actorFrom(user));
  }
}
