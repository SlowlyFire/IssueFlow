import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { actorFrom } from '../audit/actor';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { Attachment } from './attachment.entity';
import { AttachmentsService } from './attachments.service';

// Max 10 MB enforced at the multer layer. Oversized uploads trigger a
// MulterError(LIMIT_FILE_SIZE) which AllExceptionsFilter maps to 400.
// memoryStorage() keeps the bytes in a Buffer so we can inspect the
// magic numbers before writing to disk.
const UPLOAD_INTERCEPTOR = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

@Controller('tickets/:ticketId/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(UPLOAD_INTERCEPTOR)
  upload(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthUser,
  ): Promise<Attachment> {
    return this.attachments.upload(ticketId, file, actorFrom(user));
  }

  @Get()
  list(
    @Param('ticketId', ParseIntPipe) ticketId: number,
  ): Promise<Attachment[]> {
    return this.attachments.findByTicket(ticketId);
  }

  // README defines no explicit download path; we add /:id/download as the
  // natural extension of the nested resource. The Content-Disposition
  // header causes browsers to save the file with its original name.
  @Get(':attachmentId/download')
  async download(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { file, attachment } = await this.attachments.download(
      ticketId,
      attachmentId,
    );
    res.set({
      'Content-Type': attachment.mimeType,
      'Content-Disposition': `attachment; filename="${attachment.filename}"`,
      'Content-Length': attachment.sizeBytes,
    });
    return file;
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.attachments.remove(ticketId, attachmentId, actorFrom(user));
  }
}
