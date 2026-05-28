import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { Project } from './project.entity';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateProjectDto): Promise<Project> {
    return this.projects.create(dto);
  }

  @Get()
  findAll(): Promise<Project[]> {
    return this.projects.findAll();
  }

  // IMPORTANT: /projects/deleted must come before /projects/:projectId so
  // "deleted" is not matched as an integer id (Nest registers routes in
  // declaration order within a controller).
  @Get('deleted')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listDeleted(): Promise<Project[]> {
    return this.projects.listDeleted();
  }

  @Get(':projectId')
  findOne(@Param('projectId', ParseIntPipe) id: number): Promise<Project> {
    return this.projects.findOne(id);
  }

  @Patch(':projectId')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('projectId', ParseIntPipe) id: number,
    @Body() dto: UpdateProjectDto,
  ): Promise<void> {
    return this.projects.update(id, dto);
  }

  @Delete(':projectId')
  @HttpCode(HttpStatus.OK)
  softDelete(@Param('projectId', ParseIntPipe) id: number): Promise<void> {
    return this.projects.softDelete(id);
  }

  @Post(':projectId/restore')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  restore(@Param('projectId', ParseIntPipe) id: number): Promise<void> {
    return this.projects.restore(id);
  }
}
