import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from './ticket.entity';
import { TicketDependency } from './ticket-dependency.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Ticket, TicketDependency])],
})
export class TicketsModule {}
