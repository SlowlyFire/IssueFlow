import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  NotEquals,
} from 'class-validator';
import {
  TicketPriority,
  TicketStatus,
  TicketType,
} from '../../common/enums';

export class CreateTicketDto {
  @IsString()
  @Length(1, 300)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  // A ticket may be created in TODO, IN_PROGRESS, or IN_REVIEW, but never
  // directly in DONE — that would skip the entire workflow (and CLAUDE.md
  // treats DONE as the only terminal state, reached by transitioning).
  @IsOptional()
  @IsEnum(TicketStatus)
  @NotEquals(TicketStatus.DONE, {
    message: 'Ticket cannot be created directly in DONE; transition to it via PATCH',
  })
  status?: TicketStatus;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @IsEnum(TicketType)
  type: TicketType;

  @IsInt()
  @Min(1)
  projectId: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  assigneeId?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueDate?: Date;
}
