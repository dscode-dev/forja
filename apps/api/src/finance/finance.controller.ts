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
import { FinanceService } from './finance.service';
import { currency, minor } from './money';
import { object, id, note, instant, page, cursor } from './validation';
@Controller('v1/finance')
@UseGuards(AuthGuard)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}
  @Post('accounts')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  create(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    const b = object(input, [
      'idempotencyKey',
      'name',
      'type',
      'currency',
      'openingMinor',
      'openedAt',
      'source',
    ]);
    if (
      !['cash', 'savings'].includes(String(b['type'])) ||
      b['source'] !== 'user-confirmed'
    )
      throw new BadRequestException();
    return this.finance.createAccount(r.principal, id(b['idempotencyKey']), {
      name: note(b['name']),
      type: b['type'] as 'cash' | 'savings',
      currency: currency(b['currency']),
      openingMinor: minor(b['openingMinor']).toString(),
      openedAt: instant(b['openedAt'], true),
      source: 'user-confirmed',
    });
  }
  @Get('accounts')
  @Header('Cache-Control', 'no-store')
  accounts(
    @Req() r: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
  ) {
    const q = object(query, ['after', 'limit']);
    return this.finance.accounts(
      r.principal,
      q['after'] === undefined ? undefined : id(q['after']),
      page(q['limit']),
    );
  }
  @Post('postings/:kind')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  post(
    @Req() r: AuthenticatedRequest,
    @Param('kind') kind: string,
    @Body() input: unknown,
  ) {
    if (kind !== 'income' && kind !== 'expense')
      throw new BadRequestException();
    const b = object(input, [
      'idempotencyKey',
      'accountId',
      'amountMinor',
      'effectiveAt',
      'note',
    ]);
    return this.finance.posting(r.principal, id(b['idempotencyKey']), kind, {
      accountId: id(b['accountId']),
      amountMinor: minor(b['amountMinor'], true).toString(),
      effectiveAt: instant(b['effectiveAt'], true),
      note: note(b['note']),
    });
  }
  @Get('accounts/:id/history')
  @Header('Cache-Control', 'no-store')
  history(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Query() query: Record<string, unknown>,
  ) {
    const q = object(query, ['after', 'limit']);
    return this.finance.history(
      r.principal,
      id(target),
      cursor(q['after']),
      page(q['limit']),
    );
  }
  @Post('events/:id/reverse')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reverse(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    const b = object(input, ['idempotencyKey']);
    return this.finance.adjust(
      r.principal,
      id(b['idempotencyKey']),
      id(target),
    );
  }
  @Post('events/:id/correct')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  correct(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    const b = object(input, [
      'idempotencyKey',
      'kind',
      'amountMinor',
      'effectiveAt',
      'note',
    ]);
    if (b['kind'] !== 'income' && b['kind'] !== 'expense')
      throw new BadRequestException();
    return this.finance.adjust(
      r.principal,
      id(b['idempotencyKey']),
      id(target),
      {
        kind: b['kind'],
        amountMinor: minor(b['amountMinor'], true).toString(),
        effectiveAt: instant(b['effectiveAt'], true),
        note: note(b['note']),
      },
    );
  }
  @Post('accounts/:id/close')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  close(
    @Req() r: AuthenticatedRequest,
    @Param('id') target: string,
    @Body() input: unknown,
  ) {
    const b = object(input, ['idempotencyKey']);
    return this.finance.closeAccount(
      r.principal,
      id(b['idempotencyKey']),
      id(target),
    );
  }
  @Post('anchors/reconcile')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  reconcile(@Req() r: AuthenticatedRequest, @Body() input: unknown) {
    object(input ?? {}, []);
    return this.finance.anchorPending(r.principal);
  }
}
