import {
  Body,
  Controller,
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
import { strategyIntent } from './strategy-source';
import { StrategistService } from './strategist.service';
@Controller('v1/ai/estrategista')
@UseGuards(AuthGuard)
export class StrategistController {
  constructor(private readonly strategist: StrategistService) {}
  @Get() @Header('Cache-Control', 'no-store') get(
    @Req() r: AuthenticatedRequest,
    @Query() raw: unknown,
  ) {
    const b = object(raw, ['focus', 'goalId']);
    return this.strategist.get(
      r.principal,
      strategyIntent({
        focus: b['focus'],
        goalId: b['goalId'] === '' ? null : b['goalId'],
      }),
    );
  }
  @Get('proposals') @Header('Cache-Control', 'no-store') proposals(
    @Req() r: AuthenticatedRequest,
    @Query() raw: unknown,
  ) {
    const b = object(raw, ['focus', 'goalId']);
    return this.strategist.proposals(
      r.principal,
      strategyIntent({
        focus: b['focus'],
        goalId: b['goalId'] === '' ? null : b['goalId'],
      }),
    );
  }
  @Post() @HttpCode(200) @Header('Cache-Control', 'no-store') request(
    @Req() r: AuthenticatedRequest,
    @Body() raw: unknown,
  ) {
    const b = object(raw, ['intent', 'requestKey', 'retryOf']);
    return this.strategist.request(
      r.principal,
      strategyIntent(b['intent']),
      idempotency(b['requestKey']),
      b['retryOf'] === null ? null : id(b['retryOf']),
    );
  }
  @Post(':id/accept')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  accept(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() raw: unknown,
  ) {
    object(raw, []);
    return this.strategist.accept(r.principal, id(target));
  }
  @Post(':id/dismiss')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  dismiss(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() raw: unknown,
  ) {
    object(raw, []);
    return this.strategist.dismiss(r.principal, id(target));
  }
}
