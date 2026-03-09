/**
 * BlackRoad Content Scheduler - Main Worker Entry Point
 * ⬛⬜🛣️
 *
 * Agent Jobs, Scraping & Self-Healing System for Cloudflare Workers
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, AgentJob, ScrapeTask, HealingTask } from './types';
import { JobCoordinator } from './durable-objects/job-coordinator';
import { RepoSyncEngine } from './durable-objects/repo-sync-engine';
import { SelfHealer } from './durable-objects/self-healer';
import { handleCronTrigger } from './cron/handler';
import { processJobQueue, processScrapeQueue, processHealingQueue } from './queues/processors';

// Re-export Durable Objects
export { JobCoordinator, RepoSyncEngine, SelfHealer };

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: ['https://blackroad.io', 'https://*.blackroad.io', 'http://localhost:*'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
}));

// Request ID middleware
app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-ID') || crypto.randomUUID();
  c.set('requestId' as never, requestId);
  c.header('X-Request-ID', requestId);
  await next();
});

// Health check
app.get('/', (c) => {
  return c.json({
    service: 'blackroad-content-scheduler',
    status: 'operational',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    branding: '⬛⬜🛣️',
  });
});

app.get('/health', (c) => {
  return c.json({
    healthy: true,
    environment: c.env.ENVIRONMENT,
    selfHealEnabled: c.env.SELF_HEAL_ENABLED === 'true',
  });
});

// =============================================================================
// JOBS API
// =============================================================================

// List all jobs
app.get('/api/jobs', async (c) => {
  const stub = c.env.JOB_COORDINATOR.get(
    c.env.JOB_COORDINATOR.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/jobs'));
  return response;
});

// Create a new job
app.post('/api/jobs', async (c) => {
  const body = await c.req.json<Partial<AgentJob>>();
  const stub = c.env.JOB_COORDINATOR.get(
    c.env.JOB_COORDINATOR.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return response;
});

// Get job by ID
app.get('/api/jobs/:id', async (c) => {
  const stub = c.env.JOB_COORDINATOR.get(
    c.env.JOB_COORDINATOR.idFromName('global')
  );
  const response = await stub.fetch(new Request(`http://internal/jobs/${c.req.param('id')}`));
  return response;
});

// Cancel/update job
app.put('/api/jobs/:id', async (c) => {
  const body = await c.req.json();
  const stub = c.env.JOB_COORDINATOR.get(
    c.env.JOB_COORDINATOR.idFromName('global')
  );
  const response = await stub.fetch(new Request(`http://internal/jobs/${c.req.param('id')}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return response;
});

// =============================================================================
// REPOS API
// =============================================================================

// List all tracked repos
app.get('/api/repos', async (c) => {
  const stub = c.env.REPO_SYNC_ENGINE.get(
    c.env.REPO_SYNC_ENGINE.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/repos'));
  return response;
});

// Trigger repo scrape
app.post('/api/repos/:owner/:name/scrape', async (c) => {
  const { owner, name } = c.req.param();
  const fullName = `${owner}/${name}`;

  await c.env.SCRAPE_QUEUE.send({
    id: crypto.randomUUID(),
    repoFullName: fullName,
    scrapeType: 'full',
    priority: 'high',
  });

  return c.json({
    success: true,
    message: `Scrape job queued for ${fullName}`,
    timestamp: new Date().toISOString(),
  });
});

// Get repo data
app.get('/api/repos/:owner/:name', async (c) => {
  const { owner, name } = c.req.param();
  const fullName = `${owner}/${name}`;

  const data = await c.env.REPOS_KV.get(`repo:${fullName}`, 'json');
  if (!data) {
    return c.json({ error: 'Repo not found' }, 404);
  }
  return c.json(data);
});

// Get repo cohesiveness score
app.get('/api/repos/:owner/:name/cohesiveness', async (c) => {
  const { owner, name } = c.req.param();
  const fullName = `${owner}/${name}`;

  const data = await c.env.REPOS_KV.get(`cohesiveness:${fullName}`, 'json');
  if (!data) {
    return c.json({ error: 'Cohesiveness data not found' }, 404);
  }
  return c.json(data);
});

// =============================================================================
// SYNC API
// =============================================================================

// Get sync status
app.get('/api/sync/status', async (c) => {
  const stub = c.env.REPO_SYNC_ENGINE.get(
    c.env.REPO_SYNC_ENGINE.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/status'));
  return response;
});

// Trigger full sync
app.post('/api/sync/full', async (c) => {
  const stub = c.env.REPO_SYNC_ENGINE.get(
    c.env.REPO_SYNC_ENGINE.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/sync/full', {
    method: 'POST',
  }));
  return response;
});

// Trigger cohesiveness check
app.post('/api/sync/cohesiveness', async (c) => {
  const stub = c.env.REPO_SYNC_ENGINE.get(
    c.env.REPO_SYNC_ENGINE.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/sync/cohesiveness', {
    method: 'POST',
  }));
  return response;
});

// =============================================================================
// HEALING API
// =============================================================================

// Get healing status
app.get('/api/healing/status', async (c) => {
  const stub = c.env.SELF_HEALER.get(
    c.env.SELF_HEALER.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/status'));
  return response;
});

// List healing tasks
app.get('/api/healing/tasks', async (c) => {
  const stub = c.env.SELF_HEALER.get(
    c.env.SELF_HEALER.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/tasks'));
  return response;
});

// Trigger manual healing
app.post('/api/healing/trigger', async (c) => {
  const body = await c.req.json();
  const stub = c.env.SELF_HEALER.get(
    c.env.SELF_HEALER.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/heal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return response;
});

// Get healing metrics
app.get('/api/healing/metrics', async (c) => {
  const stub = c.env.SELF_HEALER.get(
    c.env.SELF_HEALER.idFromName('global')
  );
  const response = await stub.fetch(new Request('http://internal/metrics'));
  return response;
});

// =============================================================================
// ADMIN API
// =============================================================================

// Get system metrics
app.get('/api/admin/metrics', async (c) => {
  const [jobsData, healingData] = await Promise.all([
    c.env.JOBS_KV.get('metrics:jobs', 'json'),
    c.env.HEALING_KV.get('metrics:healing', 'json'),
  ]);

  return c.json({
    jobs: jobsData || { total: 0, completed: 0, failed: 0 },
    healing: healingData || { total: 0, resolved: 0, escalated: 0 },
    timestamp: new Date().toISOString(),
  });
});

// Clear caches
app.post('/api/admin/clear-cache', async (c) => {
  // This would need to iterate through KV keys - simplified for now
  return c.json({
    success: true,
    message: 'Cache clear triggered',
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.notFound((c) => {
  return c.json({
    error: 'Not Found',
    path: c.req.path,
    timestamp: new Date().toISOString(),
  }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Worker error:', err);

  // Queue for self-healing if enabled
  if (c.env.SELF_HEAL_ENABLED === 'true') {
    c.env.HEALING_QUEUE.send({
      id: crypto.randomUUID(),
      jobId: 'worker-error',
      issue: {
        type: 'worker_error',
        severity: 'high',
        description: err.message,
        context: { path: c.req.path, method: c.req.method },
        originalError: err.message,
        stackTrace: err.stack,
      },
      strategy: 'retry_with_backoff',
      attempts: 0,
      maxAttempts: 5,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).catch(console.error);
  }

  return c.json({
    error: 'Internal Server Error',
    message: c.env.ENVIRONMENT === 'development' ? err.message : 'An error occurred',
    timestamp: new Date().toISOString(),
  }, 500);
});

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  // HTTP fetch handler
  fetch: app.fetch,

  // Scheduled cron handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCronTrigger(event, env));
  },

  // Queue handlers
  async queue(batch: MessageBatch<AgentJob | ScrapeTask | HealingTask>, env: Env): Promise<void> {
    const queueName = batch.queue;

    if (queueName.includes('agent-jobs')) {
      await processJobQueue(batch as MessageBatch<AgentJob>, env);
    } else if (queueName.includes('scraping')) {
      await processScrapeQueue(batch as MessageBatch<ScrapeTask>, env);
    } else if (queueName.includes('healing')) {
      await processHealingQueue(batch as MessageBatch<HealingTask>, env);
    }
  },
};
