import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { ActorContext } from '../audit/actor';
import { AuditActions, AuditEntityTypes } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { ActorType } from '../common/enums';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateUserDto): Promise<User> {
    await this.assertUnique(dto.username, dto.email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = this.users.create({
      username: dto.username,
      email: dto.email,
      fullName: dto.fullName,
      role: dto.role,
      passwordHash,
    });
    const saved = await this.users.save(user);

    // Self-registration: the new user is the actor of their own creation.
    // (POST /users is @Public so there's no JWT to read.) The AuditService
    // strips passwordHash centrally — but the entity's @Exclude also strips
    // it via instanceToPlain, so it's gone twice over.
    await this.audit.record({
      actorType: ActorType.USER,
      actorId: saved.id,
      action: AuditActions.USER_CREATE,
      entityType: AuditEntityTypes.USER,
      entityId: saved.id,
      after: saved,
    });
    return saved;
  }

  findAll(): Promise<User[]> {
    return this.users.find({ order: { id: 'ASC' } });
  }

  async findOne(id: number): Promise<User> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  // Used by AuthService — must include passwordHash for verification.
  // Returns null instead of throwing so the controller can return a generic
  // 401 without leaking whether the username existed.
  findByUsername(username: string): Promise<User | null> {
    return this.users.findOne({ where: { username } });
  }

  async update(
    id: number,
    dto: UpdateUserDto,
    actor: ActorContext,
  ): Promise<void> {
    const user = await this.findOne(id);
    // Capture before BEFORE mutation. The AuditService's instanceToPlain
    // call freezes this snapshot independently of future mutations.
    const before = { ...user };
    if (dto.fullName !== undefined) user.fullName = dto.fullName;
    if (dto.role !== undefined) user.role = dto.role;
    const saved = await this.users.save(user);
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.USER_UPDATE,
      entityType: AuditEntityTypes.USER,
      entityId: id,
      before,
      after: saved,
    });
  }

  async remove(id: number, actor: ActorContext): Promise<void> {
    const user = await this.findOne(id);
    const before = { ...user };
    const result = await this.users.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`User ${id} not found`);
    }
    await this.audit.record({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: AuditActions.USER_DELETE,
      entityType: AuditEntityTypes.USER,
      entityId: id,
      before,
      after: null,
    });
  }

  private async assertUnique(username: string, email: string): Promise<void> {
    const existing = await this.users.findOne({
      where: [{ username }, { email }],
    });
    if (existing) {
      const field = existing.username === username ? 'username' : 'email';
      throw new ConflictException(`A user with this ${field} already exists`);
    }
  }
}
