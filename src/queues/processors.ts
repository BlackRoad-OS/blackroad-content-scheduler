/**
 * Queue Processors
 * Handle async job processing for agent jobs, scraping, and healing
 * ⬛⬜🛣️
 */

import type { Env, AgentJob, ScrapeTask, HealingTask } from '../types';
import { GitHubScraper } from '../scrapers/github';

/**
 * Process agent job queue
 */
export async function processJobQueue(
  batch: MessageBatch<AgentJob>,
  env: Env
): Promise<void> {
  const coordinator = env.JOB_COORDINATOR.get(
    env.JOB_COORDINATOR.idFromName('global')
  );

  for (const message of batch.messages) {
    const job = message.body;

    try {
      // Update job status to running
      await coordinator.fetch(new Request(`http://internal/jobs/${job.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'running' }),
      }));

      // Process based on job type
      let result: unknown;
      switch (job.type) {
        case 'scrape_repo':
          result = await handleScrapeRepoJob(job, env);
          break;

        case 'sync_content':
          result = await handleSyncContentJob(job, env);
          break;

        case 'check_cohesiveness':
          result = await handleCohesivenessJob(job, env);
          break;

        case 'self_heal':
          result = await handleSelfHealJob(job, env);
          break;

        case 'update_cache':
          result = await handleUpdateCacheJob(job, env);
          break;

        case 'full_sync':
          result = await handleFullSyncJob(job, env);
          break;

        case 'cleanup':
          result = await handleCleanupJob(job, env);
          break;

        case 'notify':
          result = await handleNotifyJob(job, env);
          break;

        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }

      // Mark job as completed
      await coordinator.fetch(new Request(`http://internal/jobs/${job.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          result,
          completedAt: new Date().toISOString(),
        }),
      }));

      message.ack();
    } catch (error) {
      console.error(`Job ${job.id} failed:`, error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check if should retry
      if (job.retryCount < job.maxRetries) {
        await coordinator.fetch(new Request(`http://internal/jobs/${job.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'pending',
            retryCount: job.retryCount + 1,
            error: errorMessage,
          }),
        }));
        message.retry();
      } else {
        // Max retries reached, trigger healing
        await coordinator.fetch(new Request(`http://internal/jobs/${job.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'healing',
            error: errorMessage,
          }),
        }));

        // Queue healing task
        await env.HEALING_QUEUE.send({
          id: crypto.randomUUID(),
          jobId: job.id,
          issue: {
            type: 'job_failure',
            severity: 'high',
            description: `Job ${job.type} failed after ${job.maxRetries} retries`,
            context: { jobId: job.id, jobType: job.type, payload: job.payload },
            originalError: errorMessage,
          },
          strategy: 'retry_with_backoff',
          attempts: 0,
          maxAttempts: 5,
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        message.ack();
      }
    }
  }
}

/**
 * Process scraping queue
 */
export async function processScrapeQueue(
  batch: MessageBatch<ScrapeTask>,
  env: Env
): Promise<void> {
  const scraper = new GitHubScraper(env);
  const syncEngine = env.REPO_SYNC_ENGINE.get(
    env.REPO_SYNC_ENGINE.idFromName('global')
  );

  for (const message of batch.messages) {
    const task = message.body;

    try {
      console.log(`Scraping ${task.repoFullName} (${task.scrapeType})`);

      // Perform the scrape
      const repoData = await scraper.scrapeRepo(
        task.repoFullName,
        task.scrapeType,
        task.etag
      );

      if (repoData) {
        // Update sync engine with new data
        await syncEngine.fetch(new Request('http://internal/sync/repo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoName: task.repoFullName }),
        }));

        // Store in KV
        await env.REPOS_KV.put(
          `repo:${task.repoFullName}`,
          JSON.stringify(repoData),
          { expirationTtl: 3600 } // 1 hour
        );

        console.log(`Successfully scraped ${task.repoFullName}`);
      } else {
        console.log(`No updates for ${task.repoFullName} (etag match)`);
      }

      message.ack();
    } catch (error) {
      console.error(`Scrape failed for ${task.repoFullName}:`, error);

      // Queue healing task for scrape failures
      await env.HEALING_QUEUE.send({
        id: crypto.randomUUID(),
        jobId: `scrape-${task.id}`,
        issue: {
          type: 'scrape_failure',
          severity: 'medium',
          description: `Failed to scrape ${task.repoFullName}`,
          context: { task, repoName: task.repoFullName },
          originalError: error instanceof Error ? error.message : 'Unknown error',
        },
        strategy: 'retry_with_backoff',
        attempts: 0,
        maxAttempts: 3,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      message.retry();
    }
  }
}

/**
 * Process healing queue
 */
export async function processHealingQueue(
  batch: MessageBatch<HealingTask>,
  env: Env
): Promise<void> {
  const healer = env.SELF_HEALER.get(
    env.SELF_HEALER.idFromName('global')
  );

  for (const message of batch.messages) {
    const task = message.body;

    try {
      // Process the healing task
      const response = await healer.fetch(new Request('http://internal/heal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task),
      }));

      const result = await response.json() as { success: boolean };

      if (result.success) {
        message.ack();
      } else {
        // Healing not complete, may need more attempts
        message.retry();
      }
    } catch (error) {
      console.error(`Healing task ${task.id} error:`, error);
      message.retry();
    }
  }
}

// Job handlers

async function handleScrapeRepoJob(job: AgentJob, env: Env): Promise<unknown> {
  const repoName = job.payload.repoName;
  if (!repoName) {
    throw new Error('Missing repoName in payload');
  }

  await env.SCRAPE_QUEUE.send({
    id: crypto.randomUUID(),
    repoFullName: repoName,
    scrapeType: job.payload.force ? 'full' : 'incremental',
    priority: job.priority,
  });

  return { queued: true, repo: repoName };
}

async function handleSyncContentJob(job: AgentJob, env: Env): Promise<unknown> {
  const syncEngine = env.REPO_SYNC_ENGINE.get(
    env.REPO_SYNC_ENGINE.idFromName('global')
  );

  const response = await syncEngine.fetch(new Request('http://internal/sync/full', {
    method: 'POST',
  }));

  return response.json();
}

async function handleCohesivenessJob(job: AgentJob, env: Env): Promise<unknown> {
  const syncEngine = env.REPO_SYNC_ENGINE.get(
    env.REPO_SYNC_ENGINE.idFromName('global')
  );

  const response = await syncEngine.fetch(new Request('http://internal/sync/cohesiveness', {
    method: 'POST',
  }));

  return response.json();
}

async function handleSelfHealJob(job: AgentJob, env: Env): Promise<unknown> {
  const healer = env.SELF_HEALER.get(
    env.SELF_HEALER.idFromName('global')
  );

  const response = await healer.fetch(new Request('http://internal/check', {
    method: 'POST',
  }));

  return response.json();
}

async function handleUpdateCacheJob(job: AgentJob, env: Env): Promise<unknown> {
  // Refresh cache for specific repos
  const targetRepos = job.payload.targetRepos || [];
  const results: Array<{ repo: string; updated: boolean }> = [];

  for (const repo of targetRepos) {
    await env.SCRAPE_QUEUE.send({
      id: crypto.randomUUID(),
      repoFullName: repo,
      scrapeType: 'metadata',
      priority: 'normal',
    });
    results.push({ repo, updated: true });
  }

  return { results };
}

async function handleFullSyncJob(job: AgentJob, env: Env): Promise<unknown> {
  const syncEngine = env.REPO_SYNC_ENGINE.get(
    env.REPO_SYNC_ENGINE.idFromName('global')
  );

  const response = await syncEngine.fetch(new Request('http://internal/sync/full', {
    method: 'POST',
  }));

  return response.json();
}

async function handleCleanupJob(job: AgentJob, env: Env): Promise<unknown> {
  const coordinator = env.JOB_COORDINATOR.get(
    env.JOB_COORDINATOR.idFromName('global')
  );

  const response = await coordinator.fetch(new Request('http://internal/cleanup', {
    method: 'POST',
  }));

  return response.json();
}

async function handleNotifyJob(job: AgentJob, _env: Env): Promise<unknown> {
  // In production, this would send notifications via webhook/email/etc
  console.log('NOTIFICATION:', job.payload);
  return { notified: true, payload: job.payload };
}
