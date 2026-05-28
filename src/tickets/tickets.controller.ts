import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ListTicketsDto } from './dto/list-tickets.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { Ticket } from './ticket.entity';
import { TicketsService } from './tickets.service';

// ─── Optimistic concurrency contract for PATCH /tickets/:ticketId ─────────────
// Every PATCH MUST send an `If-Match` header carrying the version the client
// based its edit on, e.g. `If-Match: "3"`. The server:
//   - returns the current `version` in the body of every ticket response AND
//     as an `ETag: "<version>"` header on GET/POST/PATCH;
//   - 428 Precondition Required if `If-Match` is absent (we don't silently
//     accept unversioned writes — that defeats the locking);
//   - 412 Precondition Failed if the supplied version doesn't match the
//     row's current version (either stale read OR a race that slipped past
//     the explicit check and was caught by TypeORM's @VersionColumn).
// To be re-stated in run.md when we write the run/usage docs.
// ──────────────────────────────────────────────────────────────────────────────

function setEtag(res: Response, ticket: Ticket): void {
  res.setHeader('ETag', `"${ticket.version}"`);
}

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() dto: CreateTicketDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Ticket> {
    const ticket = await this.tickets.create(dto);
    setEtag(res, ticket);
    return ticket;
  }

  // The README's list endpoint is GET /tickets?projectId=:projectId — a query
  // param, not a nested resource path. Validated via ListTicketsDto.
  @Get()
  findByProject(@Query() query: ListTicketsDto): Promise<Ticket[]> {
    return this.tickets.findByProject(query.projectId);
  }

  // IMPORTANT: /tickets/deleted MUST be declared before /tickets/:ticketId
  // — Nest registers routes in source order; otherwise "deleted" would be
  // matched as a ticket id and ParseIntPipe would 400.
  @Get('deleted')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listDeleted(@Query() query: ListTicketsDto): Promise<Ticket[]> {
    return this.tickets.listDeleted(query.projectId);
  }

  @Get(':ticketId')
  async findOne(
    @Param('ticketId', ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Ticket> {
    const ticket = await this.tickets.findOne(id);
    setEtag(res, ticket);
    return ticket;
  }

  @Patch(':ticketId')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('ticketId', ParseIntPipe) id: number,
    @Body() dto: UpdateTicketDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Ticket> {
    // If-Match parsing happens inside the service AFTER the DONE-frozen
    // check, so frozen-ness reports first regardless of header state.
    const updated = await this.tickets.update(id, dto, ifMatch);
    setEtag(res, updated);
    return updated;
  }

  @Delete(':ticketId')
  @HttpCode(HttpStatus.OK)
  softDelete(@Param('ticketId', ParseIntPipe) id: number): Promise<void> {
    return this.tickets.softDelete(id);
  }

  @Post(':ticketId/restore')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  restore(@Param('ticketId', ParseIntPipe) id: number): Promise<void> {
    return this.tickets.restore(id);
  }
}
