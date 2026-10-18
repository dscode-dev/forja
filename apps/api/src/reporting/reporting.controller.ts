import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Param,
  Query,
  Req,
  Header,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../identity/auth.guard';
import { object } from '../identity/validation';
import { id, idempotency } from '../finance/validation';
import { queryInteger } from '../work/model';
import { PlatformFailure } from '../platform/failure';
import { ReportingService } from './reporting.service';
@Controller('v1/reports')
@UseGuards(AuthGuard)
export class ReportingController {
  constructor(private readonly reports: ReportingService) {}
  @Get('periods') @Header('Cache-Control', 'no-store') periods(
    @Req() r: AuthenticatedRequest,
    @Query() raw: unknown,
  ) {
    object(raw, []);
    return this.reports.options(r.principal);
  }
  @Post(':type') @HttpCode(200) @Header('Cache-Control', 'no-store') generate(
    @Req() r: AuthenticatedRequest,
    @Param('type') type: string,
    @Body() raw: unknown,
  ) {
    if (!['daily', 'weekly', 'monthly', 'custom'].includes(type))
      throw new PlatformFailure('not_found');
    const b = object(raw, ['idempotencyKey', 'accountId', 'from', 'through']);
    return this.reports.generate(
      r.principal,
      idempotency(b['idempotencyKey']),
      {
        accountId: b['accountId'],
        type: type.toUpperCase(),
        from: b['from'],
        through: b['through'],
      },
    );
  }
  @Get('chronicles') @Header('Cache-Control', 'no-store') list(
    @Req() r: AuthenticatedRequest,
    @Query() raw: unknown,
  ) {
    const b = object(raw, ['after', 'limit']);
    return this.reports.list(
      r.principal,
      b['after'] === undefined ? 0 : queryInteger(b['after'], 2147483647),
      b['limit'] === undefined ? 20 : queryInteger(b['limit'], 50, 1),
    );
  }
  @Get('chronicles/:id') @Header('Cache-Control', 'no-store') get(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() raw: unknown,
  ) {
    object(raw, []);
    return this.reports.get(r.principal, id(target));
  }
  @Delete('chronicles/:id')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  remove(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() raw: unknown,
  ) {
    object(raw, []);
    return this.reports.remove(r.principal, id(target));
  }
}
