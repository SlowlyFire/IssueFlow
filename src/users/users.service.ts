import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
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
    return this.users.save(user);
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

  async update(id: number, dto: UpdateUserDto): Promise<void> {
    const user = await this.findOne(id);
    if (dto.fullName !== undefined) user.fullName = dto.fullName;
    if (dto.role !== undefined) user.role = dto.role;
    await this.users.save(user);
  }

  async remove(id: number): Promise<void> {
    const result = await this.users.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`User ${id} not found`);
    }
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
