import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { FinanceModule } from '../finance/finance.module';
import { PlanningModule } from '../planning/planning.module';
import { WorkModule } from '../work/work.module';
import { GameModule } from '../game/game.module';
import { ReportingService } from './reporting.service';
import { ReportingController } from './reporting.controller';
@Module({
  imports: [
    IdentityModule,
    FinanceModule,
    PlanningModule,
    WorkModule,
    GameModule,
  ],
  providers: [ReportingService],
  controllers: [ReportingController],
  exports: [ReportingService],
})
export class ReportingModule {}
