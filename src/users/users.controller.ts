import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // Registration is open; everything else requires auth.
  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.users.create(dto);
  }

  @Get()
  findAll(): Promise<User[]> {
    return this.users.findAll();
  }

  @Get(':userId')
  findOne(@Param('userId', ParseIntPipe) id: number): Promise<User> {
    return this.users.findOne(id);
  }

  @Post('update/:userId')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('userId', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ): Promise<void> {
    return this.users.update(id, dto);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.OK)
  remove(@Param('userId', ParseIntPipe) id: number): Promise<void> {
    return this.users.remove(id);
  }
}
