import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONFIG, RuntimeConfig } from './config/config';
import { SafeErrorFilter } from './platform/error-filter';
import { SafeLogger } from './platform/safe-logger';
import { NestExpressApplication } from '@nestjs/platform-express';
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '8kb', strict: true });
  const logger = app.get(SafeLogger);
  app.useGlobalFilters(new SafeErrorFilter(logger));
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.enableShutdownHooks();
  const config = app.get<RuntimeConfig>(CONFIG);
  await app.listen(config.port, config.host);
  logger.event('application.started', 'success');
}
process.on('uncaughtException', () => {
  new SafeLogger().event('application.failed', 'unavailable');
  process.exit(1);
});
process.on('unhandledRejection', () => {
  new SafeLogger().event('application.failed', 'unavailable');
  process.exit(1);
});
void bootstrap().catch(() => {
  new SafeLogger().event('application.failed', 'unavailable');
  process.exitCode = 1;
});
