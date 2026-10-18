import { StrategistService } from './strategist.service';
import { StrategistController } from './strategist.controller';
import { StrategySource } from './strategy-source';
import { FinanceModule } from '../finance/finance.module';
import { PlanningModule } from '../planning/planning.module';
import { WorkModule } from '../work/work.module';
import { GameModule } from '../game/game.module';
import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ReportingModule } from '../reporting/reporting.module';
import { AI_PROVIDER, OpenAiProvider } from './provider';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
@Module({
  imports: [
    IdentityModule,
    ReportingModule,
    FinanceModule,
    PlanningModule,
    WorkModule,
    GameModule,
  ],
  providers: [
    { provide: AI_PROVIDER, useFactory: () => new OpenAiProvider() },
    StrategistService,
    StrategySource,
    AiService,
  ],
  controllers: [AiController, StrategistController],
  exports: [AiService],
})
export class AiModule {}
