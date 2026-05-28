import { Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('ticket_dependencies')
@Index(['blockedById'])
export class TicketDependency {
  @PrimaryColumn({ type: 'int' })
  ticketId: number;

  @PrimaryColumn({ type: 'int' })
  blockedById: number;
}
