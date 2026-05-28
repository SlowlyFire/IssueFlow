import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';
import { TicketPriority, TicketStatus } from '../../common/enums';

// Per README PATCH ticket: title, description, status, priority, assigneeId,
// dueDate. `type` and `projectId` are intentionally not updatable (a ticket
// doesn't change kind or hop projects). `version` is server-managed and
// never accepted from the body — clients communicate the expected version
// via the If-Match header instead.
export class UpdateTicketDto {
  @IsOptional()
  @IsString()
  @Length(1, 300)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @IsOptional()
  @IsInt()
  @Min(1)
  assigneeId?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueDate?: Date;
}
