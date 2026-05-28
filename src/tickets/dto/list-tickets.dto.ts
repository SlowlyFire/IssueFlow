import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class ListTicketsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  projectId: number;
}
