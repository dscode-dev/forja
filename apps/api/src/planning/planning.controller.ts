import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Param,
  Query,
  Header,
  HttpCode,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../identity/auth.guard';
import { PlanningService } from './planning.service';
import { currency, minor } from '../finance/money';
import { object, id, note, instant, page } from '../finance/validation';
@Controller('v1/planning/expected')
@UseGuards(AuthGuard)
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  create(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    const b = object(input, [
      'idempotencyKey',
      'accountId',
      'currency',
      'dueAt',
      'kind',
      'amountMinor',
      'note',
      'source',
    ]);
    if (
      ![
        'predicted-income',
        'receivable',
        'scheduled-debit',
        'payable',
      ].includes(String(b['kind'])) ||
      b['source'] !== 'user-confirmed'
    )
      throw new BadRequestException();
    return this.planning.create(r.principal, id(b['idempotencyKey']), {
      accountId: id(b['accountId']),
      currency: currency(b['currency']),
      dueAt: instant(b['dueAt']),
      kind: b['kind'] as
        'predicted-income' | 'receivable' | 'scheduled-debit' | 'payable',
      amountMinor: minor(b['amountMinor'], true).toString(),
      note: note(b['note']),
      source: 'user-confirmed',
    });
  }
  @Get('summary')
  @Header('Cache-Control', 'no-store')
  summary(
    @Req() r: AuthenticatedRequest,
    @Query() input: Record<string, unknown>,
  ) {
    const b = object(input, ['accountId', 'through']);
    return this.planning.summary(
      r.principal,
      id(b['accountId']),
      instant(b['through']),
    );
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() r: AuthenticatedRequest,
    @Query() input: Record<string, unknown>,
  ) {
    const b = object(input, ['accountId', 'after', 'limit']);
    return this.planning.list(
      r.principal,
      id(b['accountId']),
      b['after'] === undefined ? undefined : id(b['after']),
      page(b['limit']),
    );
  }
  @Post(':id/settle')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  settle(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    const b = object(input, ['idempotencyKey', 'effectiveAt']);
    return this.planning.transition(
      r.principal,
      id(b['idempotencyKey']),
      id(target),
      instant(b['effectiveAt'], true),
    );
  }
  @Post(':id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    const b = object(input, ['idempotencyKey']);
    return this.planning.transition(
      r.principal,
      id(b['idempotencyKey']),
      id(target),
      null,
    );
  }
}
