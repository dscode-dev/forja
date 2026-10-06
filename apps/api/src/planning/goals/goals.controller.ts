import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Req,
  Header,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../../identity/auth.guard';
import { object, text } from '../../identity/validation';
import { id, idempotency } from '../../finance/validation';
import { integer, queryInteger } from '../../work/model';
import { GoalsService } from './goals.service';
@Controller('v1/planning/goals')
@UseGuards(AuthGuard)
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  create(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    const b = object(input, ['idempotencyKey', 'goal']);
    return this.goals.create(
      r.principal,
      idempotency(b['idempotencyKey']),
      b['goal'],
    );
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() r: AuthenticatedRequest, @Query() input: unknown) {
    const b = object(input, ['after', 'limit']);
    return this.goals.list(
      r.principal,
      b['after'] === undefined ? null : id(b['after']),
      b['limit'] === undefined ? 100 : queryInteger(b['limit'], 100, 1),
    );
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() input: unknown,
  ) {
    const b = object(input, ['revision']);
    return this.goals.get(
      r.principal,
      id(target),
      b['revision'] === undefined
        ? undefined
        : queryInteger(b['revision'], 2147483647, 1),
    );
  }
  @Put(':id')
  @Header('Cache-Control', 'no-store')
  revise(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    const b = object(input, ['idempotencyKey', 'expectedRevision', 'goal']);
    return this.goals.revise(
      r.principal,
      id(target),
      idempotency(b['idempotencyKey']),
      integer(b['expectedRevision'], 2147483646, 1),
      b['goal'],
    );
  }
  @Post(':id/state')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  state(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    const b = object(input, ['idempotencyKey', 'expectedRevision', 'action']);
    return this.goals.transition(
      r.principal,
      id(target),
      idempotency(b['idempotencyKey']),
      integer(b['expectedRevision'], 2147483646, 1),
      text(b['action'], 8),
    );
  }
  @Get(':id/progress')
  @Header('Cache-Control', 'no-store')
  progress(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() input: unknown,
  ) {
    object(input, []);
    return this.goals.progress(r.principal, id(target));
  }
  @Post(':id/calculations')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  generate(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    const b = object(input, [
      'idempotencyKey',
      'expectedRevision',
      'workRevision',
      'projectCount',
    ]);
    return this.goals.generate(
      r.principal,
      id(target),
      idempotency(b['idempotencyKey']),
      integer(b['expectedRevision'], 2147483647, 1),
      b['workRevision'] === null
        ? null
        : integer(b['workRevision'], 2147483647, 1),
      b['projectCount'] === null ? null : integer(b['projectCount'], 1000),
    );
  }
  @Get(':id/required-income')
  @Header('Cache-Control', 'no-store')
  latest(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() input: unknown,
  ) {
    object(input, []);
    return this.goals.getCalculation(r.principal, id(target), null);
  }
  @Get(':id/calculations/:calculationId')
  @Header('Cache-Control', 'no-store')
  calculation(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Param('calculationId') calculationId: string,
    @Query() input: unknown,
  ) {
    object(input, []);
    return this.goals.getCalculation(
      r.principal,
      id(target),
      id(calculationId),
    );
  }
}
