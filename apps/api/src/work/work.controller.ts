import {
  Body,
  Controller,
  Get,
  Put,
  Query,
  Req,
  Header,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../identity/auth.guard';
import { object } from '../identity/validation';
import { WorkService } from './work.service';
import { integer, queryInteger, date } from './model';
@Controller('v1/work')
@UseGuards(AuthGuard)
export class WorkController {
  constructor(private readonly work: WorkService) {}
  @Get('profile')
  @Header('Cache-Control', 'no-store')
  profile(@Req() r: AuthenticatedRequest, @Query() query: unknown) {
    const b = object(query, ['revision']);
    return this.work.profile(
      r.principal,
      b['revision'] === undefined
        ? undefined
        : queryInteger(b['revision'], 2147483647, 1),
    );
  }
  @Put('profile')
  @Header('Cache-Control', 'no-store')
  replace(@Req() r: AuthenticatedRequest, @Body() body: unknown) {
    const b = object(body, ['expectedRevision', 'profile']);
    return this.work.replace(
      r.principal,
      integer(b['expectedRevision'], 2147483646),
      b['profile'],
    );
  }
  @Get('capacity')
  @Header('Cache-Control', 'no-store')
  capacity(@Req() r: AuthenticatedRequest, @Query() query: unknown) {
    const b = object(query, ['from', 'through', 'revision', 'projectCount']);
    return this.work.capacity(
      r.principal,
      {
        from: date(b['from']),
        through: date(b['through']),
        ...(b['projectCount'] === undefined
          ? {}
          : { projectCount: queryInteger(b['projectCount'], 1000) }),
      },
      b['revision'] === undefined
        ? undefined
        : queryInteger(b['revision'], 2147483647, 1),
    );
  }
}
