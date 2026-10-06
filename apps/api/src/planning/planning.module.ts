import { WorkModule } from '../work/work.module';
import { GoalsService } from './goals/goals.service';
import { GoalsController } from './goals/goals.controller';
import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { FinanceModule } from '../finance/finance.module';
import { PlanningService } from './planning.service';
import { PlanningController } from './planning.controller';
@Module({
  imports: [IdentityModule, FinanceModule, WorkModule],
  providers: [PlanningService, GoalsService],
  controllers: [PlanningController, GoalsController],
  exports: [PlanningService, GoalsService],
})
export class PlanningModule {}
