import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { FinanceModule } from '../finance/finance.module';
import { PlanningModule } from '../planning/planning.module';
import { WorkModule } from '../work/work.module';
import { GameService } from './game.service';
import { GameController } from './game.controller';
@Module({
  imports: [IdentityModule, FinanceModule, PlanningModule, WorkModule],
  providers: [GameService],
  controllers: [GameController],
  exports: [GameService],
})
export class GameModule {}
