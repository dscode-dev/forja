import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentsHost, HttpException } from '@nestjs/common';
import { SafeLogger } from '../src/platform/safe-logger';
import { SafeErrorFilter } from '../src/platform/error-filter';
test('framework logger and error filter never serialize arbitrary sensitive inputs', () => {
  const canary = 'S3_FINANCIAL_TEST_CANARY';
  const lines: string[] = [];
  const logger = new SafeLogger((line) => lines.push(line));
  logger.error(new Error(canary));
  logger.log({ amount: canary });
  logger.warn(canary);
  const responses: unknown[] = [];
  const response = {
    status: (_status: number) => response,
    setHeader: () => {},
    json: (body: unknown) => responses.push(body),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new SafeErrorFilter(logger).catch(new Error(canary), host);
  new SafeErrorFilter(logger).catch(
    new HttpException({ message: canary }, 422),
    host,
  );
  assert.deepEqual(responses, [
    { code: 'INTERNAL_ERROR' },
    { code: 'REQUEST_REJECTED' },
  ]);
  assert.equal(JSON.stringify([lines, responses]).includes(canary), false);
  assert.equal(lines.length, 2);
});
