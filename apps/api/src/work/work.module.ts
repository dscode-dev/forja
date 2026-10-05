import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { WorkService } from './work.service';
import { WorkController } from './work.controller';
@Module({
  imports: [IdentityModule],
  providers: [WorkService],
  controllers: [WorkController],
  exports: [WorkService],
})
export class WorkModule {}
