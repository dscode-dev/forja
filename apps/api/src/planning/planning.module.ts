import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { FinanceModule } from '../finance/finance.module';
import { PlanningService } from './planning.service';
import { PlanningController } from './planning.controller';
@Module({
  imports: [IdentityModule, FinanceModule],
  providers: [PlanningService],
  controllers: [PlanningController],
  exports: [PlanningService],
})
export class PlanningModule {}
