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
import { integer, queryInteger } from '../work/model';
import { PlatformFailure } from '../platform/failure';
import { GameService } from './game.service';
@Controller('v1/game')
@UseGuards(AuthGuard)
export class GameController {
  constructor(private readonly game: GameService) {}
  @Get('progression') @Header('Cache-Control', 'no-store') summary(
    @Req() r: AuthenticatedRequest,
    @Query() input: unknown,
  ) {
    object(input, []);
    return this.game.summary(r.principal);
  }
  @Get('candidates') @Header('Cache-Control', 'no-store') candidates(
    @Req() r: AuthenticatedRequest,
    @Query() input: unknown,
  ) {
    const b = object(input, ['goalId']);
    return this.game.candidates(
      r.principal,
      b['goalId'] === undefined ? null : id(b['goalId']),
    );
  }
  @Get('missions') @Header('Cache-Control', 'no-store') list(
    @Req() r: AuthenticatedRequest,
    @Query() input: unknown,
  ) {
    const b = object(input, ['after', 'limit', 'view']);
    const view = b['view'] ?? 'active';
    if (view !== 'active' && view !== 'history')
      throw new PlatformFailure('invalid');
    return this.game.list(
      r.principal,
      b['after'] === undefined ? null : id(b['after']),
      b['limit'] === undefined ? 100 : queryInteger(b['limit'], 100, 1),
      view,
    );
  }
  @Post('missions') @HttpCode(200) @Header('Cache-Control', 'no-store') assign(
    @Req() r: AuthenticatedRequest,
    @Body() input: unknown,
  ) {
    const b = object(input, [
      'idempotencyKey',
      'template',
      'goalId',
      'goalRevision',
    ]);
    return this.game.assign(
      r.principal,
      idempotency(b['idempotencyKey']),
      b['template'],
      b['goalId'] === null ? null : id(b['goalId']),
      b['goalRevision'] === null
        ? null
        : integer(b['goalRevision'], 2147483647, 1),
    );
  }
  @Get('missions/:id') @Header('Cache-Control', 'no-store') detail(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() input: unknown,
  ) {
    object(input, []);
    return this.game.get(r.principal, id(target));
  }
  @Get('missions/:id/progress') @Header('Cache-Control', 'no-store') progress(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() input: unknown,
  ) {
    object(input, []);
    return this.game.get(r.principal, id(target));
  }
  @Post('missions/:id/evaluate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  evaluate(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    object(input, []);
    return this.game.evaluate(r.principal, id(target));
  }
  @Post('missions/:id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    object(input, []);
    return this.game.evaluate(r.principal, id(target), true);
  }
}
