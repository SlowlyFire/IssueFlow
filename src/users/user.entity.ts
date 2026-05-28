import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserRole } from '../common/enums';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  username: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 254 })
  email: string;

  @Exclude()
  @Column({ type: 'varchar', length: 200 })
  passwordHash: string;

  @Column({ type: 'varchar', length: 200 })
  fullName: string;

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  @CreateDateColumn()
  createdAt: Date;
}
