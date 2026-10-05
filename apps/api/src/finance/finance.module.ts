import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { FinanceService } from './finance.service';
import { FinanceController } from './finance.controller';
@Module({
  imports: [IdentityModule],
  providers: [FinanceService],
  controllers: [FinanceController],
  exports: [FinanceService],
})
export class FinanceModule {}
