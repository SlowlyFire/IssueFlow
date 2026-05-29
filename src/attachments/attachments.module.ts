import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { Ticket } from '../tickets/ticket.entity';
import { Attachment } from './attachment.entity';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { MimeValidatorService } from './mime-validator.service';

@Module({
  imports: [
    // Ticket re-registered for existence checks without importing TicketsModule
    TypeOrmModule.forFeature([Attachment, Ticket]),
    AuditModule,
  ],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, MimeValidatorService],
})
export class AttachmentsModule {}
