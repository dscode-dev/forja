import {
  Body,
  Controller,
  Delete,
  Get,
  Put,
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
import { integer } from '../work/model';
import { PlatformFailure } from '../platform/failure';
import { AiService } from './ai.service';
@Controller('v1/ai')
@UseGuards(AuthGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}
  @Get('preferences') @Header('Cache-Control', 'no-store') preferences(
    @Req() r: AuthenticatedRequest,
    @Query() raw: unknown,
  ) {
    object(raw, []);
    return this.ai.preferences(r.principal);
  }
  @Put('preferences') @HttpCode(200) @Header('Cache-Control', 'no-store') set(
    @Req() r: AuthenticatedRequest,
    @Body() raw: unknown,
  ) {
    const b = object(raw, ['revision', 'enabled', 'policyVersion']);
    if (
      typeof b['enabled'] !== 'boolean' ||
      typeof b['policyVersion'] !== 'string'
    )
      throw new PlatformFailure('invalid');
    return this.ai.setPreferences(
      r.principal,
      integer(b['revision'], 2147483646),
      b['enabled'],
      b['policyVersion'],
    );
  }
  @Get('alquimista/:reportId') @Header('Cache-Control', 'no-store') get(
    @Req() r: AuthenticatedRequest,
    @Param('reportId') target: string,
    @Query() raw: unknown,
  ) {
    object(raw, []);
    return this.ai.get(r.principal, id(target));
  }
  @Post('alquimista/:reportId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  request(
    @Req() r: AuthenticatedRequest,
    @Param('reportId') target: string,
    @Body() raw: unknown,
  ) {
    const b = object(raw, ['requestKey', 'retryOf']);
    return this.ai.request(
      r.principal,
      id(target),
      idempotency(b['requestKey']),
      b['retryOf'] === null ? null : id(b['retryOf']),
    );
  }
  @Get('executions/:id') @Header('Cache-Control', 'no-store') status(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() raw: unknown,
  ) {
    object(raw, []);
    return this.ai.status(r.principal, id(target));
  }
  @Delete('executions/:id')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  remove(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() raw: unknown,
  ) {
    object(raw, []);
    return this.ai.remove(r.principal, id(target));
  }
}
