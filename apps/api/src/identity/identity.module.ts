import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { OidcProvider } from './oidc';
import { AuthGuard } from './auth.guard';
@Module({
  controllers: [IdentityController],
  providers: [IdentityService, OidcProvider, AuthGuard],
  exports: [IdentityService, AuthGuard],
})
export class IdentityModule {}
