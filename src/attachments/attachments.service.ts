import {
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ActorContext } from '../audit/actor';
import { AuditActions, AuditEntityTypes } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { Ticket } from '../tickets/ticket.entity';
import { Attachment } from './attachment.entity';
import { MimeValidatorService } from './mime-validator.service';

// Storage strategy: local filesystem under the UPLOADS_DIR env var
// (default ./uploads/). The storagePath column holds the absolute path;
// the filename column holds the original user-supplied name for display.
//
// UUID-based naming for the actual file on disk prevents path traversal:
// a user uploading "../../etc/passwd" as the filename never influences
// the storage path — only the display name.
//
// Production would use S3-style object storage; the service interface
// intentionally keeps the persistence concern behind a thin wrapper so
// the swap is a one-file change (see run.md).

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly uploadsDir: string;

  constructor(
    @InjectRepository(Attachment)
    private readonly attachments: Repository<Attachment>,
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    private readonly mimeValidator: MimeValidatorService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.uploadsDir = path.resolve(
      config.get<string>('UPLOADS_DIR') ?? './uploads',
    );
    fs.mkdirSync(this.uploadsDir, { recursive: true });
  }

  async upload(
    ticketId: number,
    file: Express.Multer.File,
    actor: ActorContext,
  ): Promise<Attachment> {
    await this.assertTicketExists(ticketId);

    // MimeValidatorService throws BadRequestException if invalid.
    const validatedMime = this.mimeValidator.validate(
      file.buffer,
      file.mimetype,
    );

    // Guard against multer passing a buffer that already exceeded limits:
    // the limit is set in the interceptor, but double-check here.
    if (file.buffer.length > MAX_SIZE_BYTES) {
      throw new Error('File exceeds the 10 MB size limit (internal check)');
    }

    // UUID filename prevents path traversal; original name is stored for
    // display in the filename column.
    const ext = path.extname(file.originalname).toLowerCase();
    const storageFilename = `${randomUUID()}${ext}`;
    const storagePath = path.join(this.uploadsDir, storageFilename);

    fs.writeFileSync(storagePath, file.buffer);

    const attachment = this.attachments.create({
      ticketId,
      filename: file.originalname,
      mimeType: validatedMime,
      sizeBytes: String(file.buffer.length),
      storagePath,
      uploadedById: actor.actorId ?? 0,
    });
    const saved = await this.attachments.save(attachment);

    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.ATTACHMENT_UPLOAD,
      entityType: AuditEntityTypes.ATTACHMENT,
      entityId: saved.id,
      after: {
        id: saved.id,
        ticketId,
        filename: saved.filename,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        uploadedById: saved.uploadedById,
      },
    });

    return saved;
  }

  async findByTicket(ticketId: number): Promise<Attachment[]> {
    await this.assertTicketExists(ticketId);
    return this.attachments.find({
      where: { ticketId },
      order: { id: 'ASC' },
    });
  }

  async download(
    ticketId: number,
    attachmentId: number,
  ): Promise<{ file: StreamableFile; attachment: Attachment }> {
    const attachment = await this.findAttachment(ticketId, attachmentId);
    if (!fs.existsSync(attachment.storagePath)) {
      throw new NotFoundException(
        `File for attachment ${attachmentId} not found on disk`,
      );
    }
    const stream = fs.createReadStream(attachment.storagePath);
    return {
      file: new StreamableFile(stream),
      attachment,
    };
  }

  async remove(
    ticketId: number,
    attachmentId: number,
    actor: ActorContext,
  ): Promise<void> {
    const attachment = await this.findAttachment(ticketId, attachmentId);
    const before = { ...attachment };

    await this.attachments.delete(attachmentId);

    // File deletion is best-effort: if the file is already gone (disk
    // cleaned by an operator, corrupted FS, etc.) we log and move on.
    // The row deletion is the authoritative state — the DB is the record
    // of truth; the filesystem is just the backing store.
    try {
      fs.unlinkSync(attachment.storagePath);
    } catch (err) {
      this.logger.warn(
        `Could not delete file at ${attachment.storagePath}: ${(err as Error).message}`,
      );
    }

    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.ATTACHMENT_DELETE,
      entityType: AuditEntityTypes.ATTACHMENT,
      entityId: attachmentId,
      before,
      after: null,
    });
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async assertTicketExists(ticketId: number): Promise<void> {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);
  }

  private async findAttachment(
    ticketId: number,
    attachmentId: number,
  ): Promise<Attachment> {
    const a = await this.attachments.findOne({
      where: { id: attachmentId, ticketId },
    });
    if (!a) {
      throw new NotFoundException(
        `Attachment ${attachmentId} not found on ticket ${ticketId}`,
      );
    }
    return a;
  }
}
