import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';

/**
 * `/health` is liveness — it must stay 200 even when a dependency is down, or
 * an orchestrator will kill a pod that is merely waiting on Postgres.
 * `/health/ready` is the one that gates traffic.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  liveness(): { status: string; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  async readiness(): Promise<{ status: string; checks: Record<string, string> }> {
    const [database, cache] = await Promise.all([this.prisma.isHealthy(), this.redis.isHealthy()]);

    const checks = {
      database: database ? 'ok' : 'fail',
      redis: cache ? 'ok' : 'fail',
    };

    if (!database || !cache) {
      throw new ServiceUnavailableException({ status: 'degraded', checks });
    }
    return { status: 'ok', checks };
  }
}
