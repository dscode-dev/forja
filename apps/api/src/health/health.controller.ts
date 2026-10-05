import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
  Inject,
} from '@nestjs/common';
import { CryptoPlatform } from '../platform/crypto/crypto-platform';
import { Database } from '../platform/database';
import { AUTH_CONTROL, AuthControl } from '../platform/auth-control';
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: Database,
    private readonly crypto: CryptoPlatform,
    @Inject(AUTH_CONTROL) private readonly auth: AuthControl,
  ) {}
  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(): Promise<{ status: 'ok' }> {
    if (
      !(await this.database.ready()) ||
      !(await this.crypto.ready()) ||
      !(await this.auth.ready())
    )
      throw new ServiceUnavailableException();
    return { status: 'ok' };
  }
}
