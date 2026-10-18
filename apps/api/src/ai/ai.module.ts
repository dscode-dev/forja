import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ReportingModule } from '../reporting/reporting.module';
import { AI_PROVIDER, OpenAiProvider } from './provider';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
@Module({
  imports: [IdentityModule, ReportingModule],
  providers: [
    { provide: AI_PROVIDER, useFactory: () => new OpenAiProvider() },
    AiService,
  ],
  controllers: [AiController],
  exports: [AiService],
})
export class AiModule {}
