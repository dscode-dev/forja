import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { SafeLogger } from './safe-logger';
import { PlatformFailure } from './failure';
interface SafeResponse {
  status(code: number): SafeResponse;
  setHeader(name: string, value: string): void;
  json(body: object): void;
}
@Catch()
export class SafeErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: SafeLogger) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    const candidate =
      exception instanceof HttpException
        ? exception.getStatus()
        : exception instanceof PlatformFailure
          ? {
              invalid: 400,
              unavailable: 503,
              conflict: 409,
              integrity: 503,
              fenced: 401,
              exhausted: 429,
              commit_unknown: 503,
            }[exception.code]
          : exception &&
              typeof exception === 'object' &&
              'type' in exception &&
              exception.type === 'entity.too.large'
            ? 413
            : exception &&
                typeof exception === 'object' &&
                'type' in exception &&
                exception.type === 'entity.parse.failed'
              ? 400
              : 500;
    const status = candidate >= 400 && candidate <= 599 ? candidate : 500;
    const response = host.switchToHttp().getResponse<SafeResponse>();
    response.setHeader('Cache-Control', 'no-store');
    this.logger.event(
      'http.request.failed',
      status < 500 ? 'rejected' : 'unavailable',
    );
    response.status(status).json({
      code:
        status === 503
          ? 'UNAVAILABLE'
          : status >= 500
            ? 'INTERNAL_ERROR'
            : 'REQUEST_REJECTED',
    });
  }
}
