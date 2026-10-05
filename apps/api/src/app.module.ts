import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PlatformModule } from './platform/platform.module';
import { IdentityModule } from './identity/identity.module';
@Module({
  imports: [PlatformModule, IdentityModule],
  controllers: [HealthController],
})
export class AppModule {}
