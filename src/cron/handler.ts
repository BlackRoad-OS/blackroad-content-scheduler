/**
 * Cron Handler
 * Manages scheduled tasks for the content scheduler
 * ⬛⬜🛣️
 */

import type { Env } from '../types';

/**
 * Handle cron trigger events
 * Schedules:
 * - Every 30 minutes: Scrape repos
 * - Every hour: Cohesiveness check
 * - Every 5 minutes: Self-healing check
 * - Daily: Full sync and cleanup
 */
export async function handleCronTrigger(
  event: ScheduledEvent,
  env: Env
): Promise<void> {
  const cron = event.cron;
  console.log(`Cron triggered: ${cron} at ${new Date().toISOString()}`);

  try {
    switch (cron) {
      // Every 30 minutes: Incremental repo scraping
      case '*/30 * * * *':
        await triggerIncrementalScrape(env);
        break;

      // Every hour: Cohesiveness check
      case '0 * * * *':
        await triggerCohesivenessCheck(env);
        break;

      // Every 5 minutes: Self-healing check
      case '*/5 * * * *':
        await triggerSelfHealingCheck(env);
        break;

      // Daily at midnight: Full sync and cleanup
      case '0 0 * * *':
        await triggerDailyMaintenance(env);
        break;

      default:
        console.log(`Unknown cron schedule: ${cron}`);
    }
  } catch (error) {
    console.error(`Cron handler error for ${cron}:`, error);

    // Queue healing task for cron failures
    await env.HEALING_QUEUE.send({
      id: crypto.randomUUID(),
      jobId: `cron-${cron.replace(/\s+/g, '-')}`,
      issue: {
        type: 'cron_failure',
        severity: 'high',
        description: `Cron job failed: ${cron}`,
        context: { cron, scheduledTime: event.scheduledTime },
        originalError: error instanceof Error ? error.message : 'Unknown error',
      },
      strategy: 'retry_with_backoff',
      attempts: 0,
      maxAttempts: 3,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

/**
 * Trigger incremental scraping of all tracked repos
 */
async function triggerIncrementalScrape(env: Env): Promise<void> {
  console.log('Starting incremental repo scrape');

  const syncEngine = env.REPO_SYNC_ENGINE.get(
    env.REPO_SYNC_ENGINE.idFromName('global')
  );

  // Get list of tracked repos
  const response = await syncEngine.fetch(new Request('http://internal/repos'));
  const data = await response.json() as { knownRepos: string[] };

  const org = env.BLACKROAD_ORG || 'BlackRoad-OS';

  // Queue scrape tasks for each repo
  for (const repoName of data.knownRepos) {
    const fullName = repoName.includes('/') ? repoName : `${org}/${repoName}`;

    await env.SCRAPE_QUEUE.send({
      id: crypto.randomUUID(),
      repoFullName: fullName,
      scrapeType: 'incremental',
      priority: 'normal',
    });
  }

  console.log(`Queued incremental scrape for ${data.knownRepos.length} repos`);

  // Update metrics
  await env.JOBS_KV.put('metrics:last_incremental_scrape', new Date().toISOString());
}

/**
 * Trigger cohesiveness check across all repos
 */
async function triggerCohesivenessCheck(env: Env): Promise<void> {
  console.log('Starting cohesiveness check');

  const syncEngine = env.REPO_SYNC_ENGINE.get(
    env.REPO_SYNC_ENGINE.idFromName('global')
  );

  const response = await syncEngine.fetch(new Request('http://internal/sync/cohesiveness', {
    method: 'POST',
  }));

  const result = await response.json();
  console.log('Cohesiveness check complete:', result);

  await env.JOBS_KV.put('metrics:last_cohesiveness_check', new Date().toISOString());
}

/**
 * Trigger self-healing system check
 */
async function triggerSelfHealingCheck(env: Env): Promise<void> {
  if (env.SELF_HEAL_ENABLED !== 'true') {
    console.log('Self-healing is disabled, skipping check');
    return;
  }

  console.log('Starting self-healing check');

  const healer = env.SELF_HEALER.get(
    env.SELF_HEALER.idFromName('global')
  );

  // Run health check
  const healthResponse = await healer.fetch(new Request('http://internal/check', {
    method: 'POST',
  }));
  const healthResult = await healthResponse.json() as { healthy: boolean; issues: unknown[] };

  if (!healthResult.healthy) {
    console.log('Health check found issues:', healthResult.issues);
  }

  // Check for stale jobs that might need healing
  const coordinator = env.JOB_COORDINATOR.get(
    env.JOB_COORDINATOR.idFromName('global')
  );

  const jobsResponse = await coordinator.fetch(
    new Request('http://internal/jobs?status=running')
  );
  const jobsData = await jobsResponse.json() as { jobs: Array<{ id: string; updatedAt: string; type: string }> };

  // Find jobs that have been running too long (> 10 minutes)
  const now = Date.now();
  const staleThreshold = 10 * 60 * 1000; // 10 minutes

  for (const job of jobsData.jobs) {
    const jobAge = now - new Date(job.updatedAt).getTime();
    if (jobAge > staleThreshold) {
      console.log(`Found stale job: ${job.id} (age: ${Math.round(jobAge / 1000)}s)`);

      // Queue healing task
      await env.HEALING_QUEUE.send({
        id: crypto.randomUUID(),
        jobId: job.id,
        issue: {
          type: 'stale_job',
          severity: 'medium',
          description: `Job ${job.id} has been running for ${Math.round(jobAge / 60000)} minutes`,
          context: { jobId: job.id, jobType: job.type, age: jobAge },
        },
        strategy: 'full_reset',
        attempts: 0,
        maxAttempts: 1,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  await env.HEALING_KV.put('metrics:last_healing_check', new Date().toISOString());
}

/**
 * Trigger daily maintenance tasks
 */
async function triggerDailyMaintenance(env: Env): Promise<void> {
  console.log('Starting daily maintenance');

  // 1. Full sync of all repos
  const syncEngine = env.REPO_SYNC_ENGINE.get(
    env.REPO_SYNC_ENGINE.idFromName('global')
  );

  await syncEngine.fetch(new Request('http://internal/sync/full', {
    method: 'POST',
  }));

  // 2. Cleanup old completed jobs
  const coordinator = env.JOB_COORDINATOR.get(
    env.JOB_COORDINATOR.idFromName('global')
  );

  const cleanupResponse = await coordinator.fetch(new Request('http://internal/cleanup', {
    method: 'POST',
  }));
  const cleanupResult = await cleanupResponse.json();
  console.log('Job cleanup result:', cleanupResult);

  // 3. Generate daily report
  const metricsResponse = await coordinator.fetch(new Request('http://internal/metrics'));
  const metrics = await metricsResponse.json();

  const healerMetricsResponse = await env.SELF_HEALER.get(
    env.SELF_HEALER.idFromName('global')
  ).fetch(new Request('http://internal/metrics'));
  const healerMetrics = await healerMetricsResponse.json();

  const dailyReport = {
    date: new Date().toISOString().split('T')[0],
    jobs: metrics,
    healing: healerMetrics,
    generatedAt: new Date().toISOString(),
  };

  // Store daily report
  await env.CONTENT_KV.put(
    `report:daily:${dailyReport.date}`,
    JSON.stringify(dailyReport),
    { expirationTtl: 30 * 24 * 60 * 60 } // 30 days
  );

  console.log('Daily maintenance complete');
  await env.JOBS_KV.put('metrics:last_daily_maintenance', new Date().toISOString());
}
