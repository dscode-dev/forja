import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Req,
  Header,
  HttpCode,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { IdentityService } from './identity.service';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import {
  object,
  text,
  tokenPattern,
  uuidPattern,
  profileInput,
} from './validation';
@Controller('v1')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}
  @Post('auth/begin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  begin(@Body() body: unknown) {
    const row = object(body, ['codeChallenge', 'intent']);
    const challenge = text(row['codeChallenge'], 43, tokenPattern);
    if (!['login', 'register'].includes(String(row['intent'])))
      throw new BadRequestException();
    return this.identity.begin(
      challenge,
      row['intent'] as 'login' | 'register',
    );
  }
  @Post('auth/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  complete(@Body() body: unknown) {
    const row = object(body, [
      'challengeId',
      'state',
      'nonce',
      'code',
      'codeVerifier',
    ]);
    return this.identity.complete(
      text(row['challengeId'], 36, uuidPattern),
      text(row['state'], 43, tokenPattern),
      text(row['nonce'], 43, tokenPattern),
      text(row['code'], 2048),
      text(row['codeVerifier'], 128, /^[A-Za-z0-9._~-]{43,128}$/u),
    );
  }
  @Post('auth/refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  refresh(@Body() body: unknown) {
    const row = object(body, ['refreshToken']);
    return this.identity.refresh(text(row['refreshToken'], 43, tokenPattern));
  }
  @Post('auth/logout')
  @UseGuards(AuthGuard)
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  logout(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    object(body ?? {}, []);
    return this.identity.logout(request.principal);
  }
  @Post('auth/revoke-all')
  @UseGuards(AuthGuard)
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  revokeAll(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    object(body ?? {}, []);
    return this.identity.revokeAll(request.principal);
  }
  @Get('me')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  me(@Req() request: AuthenticatedRequest) {
    return this.identity.profile(request.principal);
  }
  @Put('me/profile')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  update(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const row = object(body, ['revision', 'profile']);
    const revision = row['revision'];
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision >= 2147483647
    )
      throw new BadRequestException();
    return this.identity.update(
      request.principal,
      revision,
      profileInput(row['profile']),
    );
  }
  @Delete('me')
  @UseGuards(AuthGuard)
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  delete(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    object(body ?? {}, []);
    return this.identity.deletion(request.principal);
  }
}
