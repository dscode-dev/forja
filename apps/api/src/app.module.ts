import { WorkModule } from './work/work.module';
import { FinanceModule } from './finance/finance.module';
import { PlanningModule } from './planning/planning.module';
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PlatformModule } from './platform/platform.module';
import { IdentityModule } from './identity/identity.module';
@Module({
  imports: [
    WorkModule,
    FinanceModule,
    PlanningModule,
    PlatformModule,
    IdentityModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
