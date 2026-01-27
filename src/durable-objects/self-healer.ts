/**
 * Self-Healer Durable Object
 * Manages automatic issue detection and resolution
 * ⬛⬜🛣️
 */

import type { Env, HealingTask, HealingStrategy, HealingResolution } from '../types';

interface HealerState {
  tasks: Record<string, HealingTask>;
  metrics: HealingMetrics;
  strategies: StrategyStats;
}

interface HealingMetrics {
  totalAttempts: number;
  successfulResolutions: number;
  failedResolutions: number;
  escalations: number;
  averageTimeToResolve: number;
}

interface StrategyStats {
  [strategy: string]: {
    attempts: number;
    successes: number;
    failures: number;
  };
}

const STRATEGY_CONFIGS: Record<HealingStrategy, {
  maxAttempts: number;
  backoffMs: number[];
  nextStrategy?: HealingStrategy;
}> = {
  retry_with_backoff: {
    maxAttempts: 5,
    backoffMs: [1000, 2000, 4000, 8000, 16000],
    nextStrategy: 'clear_cache_retry',
  },
  clear_cache_retry: {
    maxAttempts: 2,
    backoffMs: [2000, 5000],
    nextStrategy: 'switch_endpoint',
  },
  switch_endpoint: {
    maxAttempts: 3,
    backoffMs: [1000, 3000, 5000],
    nextStrategy: 'reduce_batch_size',
  },
  reduce_batch_size: {
    maxAttempts: 3,
    backoffMs: [1000, 2000, 3000],
    nextStrategy: 'notify_and_skip',
  },
  notify_and_skip: {
    maxAttempts: 1,
    backoffMs: [0],
    nextStrategy: 'escalate_to_agent',
  },
  full_reset: {
    maxAttempts: 1,
    backoffMs: [5000],
    nextStrategy: 'escalate_to_agent',
  },
  escalate_to_agent: {
    maxAttempts: 1,
    backoffMs: [0],
  },
};

export class SelfHealer implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private tasks: Map<string, HealingTask> = new Map();
  private metrics: HealingMetrics = {
    totalAttempts: 0,
    successfulResolutions: 0,
    failedResolutions: 0,
    escalations: 0,
    averageTimeToResolve: 0,
  };
  private strategies: StrategyStats = {};

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<HealerState>('state');
      if (stored) {
        this.tasks = new Map(Object.entries(stored.tasks || {}));
        this.metrics = stored.metrics || this.metrics;
        this.strategies = stored.strategies || {};
      }
    });
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', {
      tasks: Object.fromEntries(this.tasks),
      metrics: this.metrics,
      strategies: this.strategies,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /status - Get healer status
      if (path === '/status' && request.method === 'GET') {
        return this.getStatus();
      }

      // GET /tasks - List healing tasks
      if (path === '/tasks' && request.method === 'GET') {
        return this.listTasks(url);
      }

      // POST /heal - Process healing task
      if (path === '/heal' && request.method === 'POST') {
        const task = await request.json() as HealingTask;
        return this.processHealingTask(task);
      }

      // POST /resolve - Mark task as resolved
      if (path === '/resolve' && request.method === 'POST') {
        const body = await request.json() as { taskId: string; resolution: HealingResolution };
        return this.resolveTask(body.taskId, body.resolution);
      }

      // GET /metrics - Get healing metrics
      if (path === '/metrics' && request.method === 'GET') {
        return this.getMetrics();
      }

      // POST /check - Run health check
      if (path === '/check' && request.method === 'POST') {
        return this.runHealthCheck();
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('SelfHealer error:', error);
      return new Response(JSON.stringify({
        error: 'Internal error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async getStatus(): Promise<Response> {
    const pendingTasks = Array.from(this.tasks.values()).filter(
      (t) => t.status === 'pending' || t.status === 'attempting'
    );
    const resolvedTasks = Array.from(this.tasks.values()).filter(
      (t) => t.status === 'resolved'
    );
    const escalatedTasks = Array.from(this.tasks.values()).filter(
      (t) => t.status === 'escalated'
    );

    return new Response(JSON.stringify({
      enabled: this.env.SELF_HEAL_ENABLED === 'true',
      status: pendingTasks.length > 0 ? 'active' : 'idle',
      pending: pendingTasks.length,
      resolved: resolvedTasks.length,
      escalated: escalatedTasks.length,
      successRate: this.metrics.totalAttempts > 0
        ? Math.round((this.metrics.successfulResolutions / this.metrics.totalAttempts) * 100)
        : 100,
      timestamp: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async listTasks(url: URL): Promise<Response> {
    const status = url.searchParams.get('status');
    const limit = parseInt(url.searchParams.get('limit') || '50');

    let tasks = Array.from(this.tasks.values());

    if (status) {
      tasks = tasks.filter((t) => t.status === status);
    }

    // Sort by creation time descending
    tasks.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    tasks = tasks.slice(0, limit);

    return new Response(JSON.stringify({
      tasks,
      total: this.tasks.size,
      filtered: tasks.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async processHealingTask(task: HealingTask): Promise<Response> {
    // Store the task
    this.tasks.set(task.id, task);
    await this.persist();

    // Check if healing is enabled
    if (this.env.SELF_HEAL_ENABLED !== 'true') {
      task.status = 'escalated';
      task.updatedAt = new Date().toISOString();
      this.tasks.set(task.id, task);
      await this.persist();

      return new Response(JSON.stringify({
        success: false,
        message: 'Self-healing is disabled, task escalated',
        task,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Attempt healing
    const result = await this.attemptHealing(task);

    return new Response(JSON.stringify({
      success: result.success,
      task: this.tasks.get(task.id),
      resolution: result,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async attemptHealing(task: HealingTask): Promise<HealingResolution> {
    const startTime = Date.now();
    task.status = 'attempting';
    task.attempts++;
    task.updatedAt = new Date().toISOString();

    const strategyConfig = STRATEGY_CONFIGS[task.strategy];
    this.metrics.totalAttempts++;

    // Track strategy usage
    if (!this.strategies[task.strategy]) {
      this.strategies[task.strategy] = { attempts: 0, successes: 0, failures: 0 };
    }
    this.strategies[task.strategy].attempts++;

    let success = false;
    let message = '';

    try {
      // Execute strategy-specific healing
      switch (task.strategy) {
        case 'retry_with_backoff':
          success = await this.retryWithBackoff(task, strategyConfig.backoffMs[task.attempts - 1]);
          message = success ? 'Retry succeeded' : 'Retry failed';
          break;

        case 'clear_cache_retry':
          await this.clearRelatedCache(task);
          success = await this.retryOriginalOperation(task);
          message = success ? 'Cache cleared and retry succeeded' : 'Cache clear did not help';
          break;

        case 'switch_endpoint':
          success = await this.trySwitchEndpoint(task);
          message = success ? 'Switched to backup endpoint' : 'No backup endpoint available';
          break;

        case 'reduce_batch_size':
          success = await this.reduceBatchAndRetry(task);
          message = success ? 'Reduced batch size succeeded' : 'Batch reduction did not help';
          break;

        case 'notify_and_skip':
          await this.notifyAndSkip(task);
          success = true;
          message = 'Issue logged and skipped';
          break;

        case 'full_reset':
          success = await this.performFullReset(task);
          message = success ? 'Full reset completed' : 'Full reset failed';
          break;

        case 'escalate_to_agent':
          await this.escalateToAgent(task);
          task.status = 'escalated';
          this.metrics.escalations++;
          message = 'Escalated to agent for manual resolution';
          success = false;
          break;
      }
    } catch (error) {
      success = false;
      message = `Healing error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }

    const timeToResolve = Date.now() - startTime;

    if (success) {
      this.metrics.successfulResolutions++;
      this.strategies[task.strategy].successes++;
      task.status = 'resolved';

      // Update average time to resolve
      const totalResolved = this.metrics.successfulResolutions;
      this.metrics.averageTimeToResolve = Math.round(
        ((this.metrics.averageTimeToResolve * (totalResolved - 1)) + timeToResolve) / totalResolved
      );
    } else {
      this.strategies[task.strategy].failures++;

      // Try next strategy if available
      if (task.attempts >= task.maxAttempts && strategyConfig.nextStrategy) {
        task.strategy = strategyConfig.nextStrategy;
        task.attempts = 0;
        task.maxAttempts = STRATEGY_CONFIGS[strategyConfig.nextStrategy].maxAttempts;
        task.status = 'pending';

        // Queue for next attempt
        await this.env.HEALING_QUEUE.send(task);
      } else if (task.attempts >= task.maxAttempts) {
        task.status = 'escalated';
        this.metrics.failedResolutions++;
        this.metrics.escalations++;
      } else {
        task.status = 'pending';
        // Queue with backoff
        await this.env.HEALING_QUEUE.send(task);
      }
    }

    const resolution: HealingResolution = {
      strategy: task.strategy,
      success,
      message,
      attemptNumber: task.attempts,
      resolvedAt: new Date().toISOString(),
      metrics: {
        timeToResolve,
        resourcesUsed: 1,
      },
    };

    task.resolution = resolution;
    task.updatedAt = new Date().toISOString();
    this.tasks.set(task.id, task);
    await this.persist();

    return resolution;
  }

  // Strategy implementations
  private async retryWithBackoff(task: HealingTask, delayMs: number): Promise<boolean> {
    await this.sleep(delayMs);
    return this.retryOriginalOperation(task);
  }

  private async clearRelatedCache(task: HealingTask): Promise<void> {
    const context = task.issue.context;
    if (context.repoName) {
      await this.env.REPOS_KV.delete(`repo:${context.repoName}`);
      await this.env.REPOS_KV.delete(`cohesiveness:${context.repoName}`);
    }
    if (context.jobId) {
      await this.env.JOBS_KV.delete(`cache:${context.jobId}`);
    }
  }

  private async retryOriginalOperation(task: HealingTask): Promise<boolean> {
    // Re-queue the original job
    if (task.jobId && task.jobId !== 'worker-error') {
      await this.env.JOBS_QUEUE.send({
        id: task.jobId,
        type: 'sync_content',
        status: 'pending',
        priority: 'high',
        payload: task.issue.context as Record<string, unknown>,
        retryCount: task.attempts,
        maxRetries: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        healingAttempts: task.attempts,
      });
      return true;
    }
    return false;
  }

  private async trySwitchEndpoint(_task: HealingTask): Promise<boolean> {
    // In a real implementation, this would switch to a backup API endpoint
    // For now, simulate a 50% success rate
    return Math.random() > 0.5;
  }

  private async reduceBatchAndRetry(task: HealingTask): Promise<boolean> {
    const context = task.issue.context;
    const currentBatch = (context.batchSize as number) || 10;
    const newBatch = Math.max(1, Math.floor(currentBatch / 2));

    task.issue.context = { ...context, batchSize: newBatch };
    return this.retryOriginalOperation(task);
  }

  private async notifyAndSkip(task: HealingTask): Promise<void> {
    // Log the issue for later review
    await this.env.HEALING_KV.put(
      `skipped:${task.id}`,
      JSON.stringify({
        task,
        skippedAt: new Date().toISOString(),
      }),
      { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
    );
  }

  private async performFullReset(task: HealingTask): Promise<boolean> {
    const context = task.issue.context;

    // Clear all related state
    if (context.repoName) {
      await this.env.REPOS_KV.delete(`repo:${context.repoName}`);
      await this.env.REPOS_KV.delete(`cohesiveness:${context.repoName}`);

      // Re-queue fresh scrape
      await this.env.SCRAPE_QUEUE.send({
        id: crypto.randomUUID(),
        repoFullName: context.repoName as string,
        scrapeType: 'full',
        priority: 'critical',
      });
      return true;
    }
    return false;
  }

  private async escalateToAgent(task: HealingTask): Promise<void> {
    // Store escalation for agent review
    await this.env.HEALING_KV.put(
      `escalated:${task.id}`,
      JSON.stringify({
        task,
        escalatedAt: new Date().toISOString(),
        requiresHumanReview: true,
      })
    );

    // Create a high-priority job for agent attention
    await this.env.JOBS_QUEUE.send({
      id: crypto.randomUUID(),
      type: 'notify',
      status: 'pending',
      priority: 'critical',
      payload: {
        type: 'escalation',
        taskId: task.id,
        issue: task.issue,
        message: `Self-healing exhausted all strategies for: ${task.issue.description}`,
      },
      retryCount: 0,
      maxRetries: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      healingAttempts: 0,
    });
  }

  private async resolveTask(taskId: string, resolution: HealingResolution): Promise<Response> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    task.status = 'resolved';
    task.resolution = resolution;
    task.updatedAt = new Date().toISOString();
    this.tasks.set(taskId, task);
    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      task,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async getMetrics(): Promise<Response> {
    return new Response(JSON.stringify({
      metrics: this.metrics,
      strategies: this.strategies,
      taskStats: {
        total: this.tasks.size,
        pending: Array.from(this.tasks.values()).filter((t) => t.status === 'pending').length,
        attempting: Array.from(this.tasks.values()).filter((t) => t.status === 'attempting').length,
        resolved: Array.from(this.tasks.values()).filter((t) => t.status === 'resolved').length,
        escalated: Array.from(this.tasks.values()).filter((t) => t.status === 'escalated').length,
      },
      timestamp: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async runHealthCheck(): Promise<Response> {
    const issues: Array<{ type: string; severity: string; message: string }> = [];

    // Check for stale tasks
    const now = Date.now();
    for (const task of this.tasks.values()) {
      const age = now - new Date(task.createdAt).getTime();
      if (task.status === 'pending' && age > 30 * 60 * 1000) { // 30 minutes
        issues.push({
          type: 'stale_task',
          severity: 'warning',
          message: `Task ${task.id} has been pending for over 30 minutes`,
        });
      }
    }

    // Check escalation rate
    if (this.metrics.totalAttempts > 10) {
      const escalationRate = this.metrics.escalations / this.metrics.totalAttempts;
      if (escalationRate > 0.3) {
        issues.push({
          type: 'high_escalation_rate',
          severity: 'critical',
          message: `Escalation rate is ${Math.round(escalationRate * 100)}% - review healing strategies`,
        });
      }
    }

    return new Response(JSON.stringify({
      healthy: issues.filter((i) => i.severity === 'critical').length === 0,
      issues,
      timestamp: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
