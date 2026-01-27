/**
 * Job Coordinator Durable Object
 * Manages agent jobs with persistent state and coordination
 * ⬛⬜🛣️
 */

import type { Env, AgentJob, JobStatus, JobPriority, JobType } from '../types';

interface JobState {
  jobs: Map<string, AgentJob>;
  metrics: {
    totalCreated: number;
    totalCompleted: number;
    totalFailed: number;
    totalHealing: number;
  };
  lastCleanup: string;
}

export class JobCoordinator implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private jobs: Map<string, AgentJob> = new Map();
  private metrics = {
    totalCreated: 0,
    totalCompleted: 0,
    totalFailed: 0,
    totalHealing: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Load state on initialization
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<JobState>('state');
      if (stored) {
        this.jobs = new Map(Object.entries(stored.jobs || {}));
        this.metrics = stored.metrics || this.metrics;
      }
    });
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', {
      jobs: Object.fromEntries(this.jobs),
      metrics: this.metrics,
      lastCleanup: new Date().toISOString(),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /jobs - List all jobs
      if (path === '/jobs' && request.method === 'GET') {
        return this.listJobs(url);
      }

      // POST /jobs - Create new job
      if (path === '/jobs' && request.method === 'POST') {
        return this.createJob(request);
      }

      // GET /jobs/:id - Get specific job
      const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
      if (jobMatch && request.method === 'GET') {
        return this.getJob(jobMatch[1]);
      }

      // PUT /jobs/:id - Update job
      if (jobMatch && request.method === 'PUT') {
        return this.updateJob(jobMatch[1], request);
      }

      // DELETE /jobs/:id - Delete job
      if (jobMatch && request.method === 'DELETE') {
        return this.deleteJob(jobMatch[1]);
      }

      // GET /metrics - Get metrics
      if (path === '/metrics' && request.method === 'GET') {
        return this.getMetrics();
      }

      // POST /cleanup - Cleanup old jobs
      if (path === '/cleanup' && request.method === 'POST') {
        return this.cleanup();
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('JobCoordinator error:', error);
      return new Response(JSON.stringify({
        error: 'Internal error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async listJobs(url: URL): Promise<Response> {
    const status = url.searchParams.get('status') as JobStatus | null;
    const type = url.searchParams.get('type') as JobType | null;
    const limit = parseInt(url.searchParams.get('limit') || '100');

    let jobs = Array.from(this.jobs.values());

    if (status) {
      jobs = jobs.filter((j) => j.status === status);
    }
    if (type) {
      jobs = jobs.filter((j) => j.type === type);
    }

    // Sort by priority and creation time
    const priorityOrder: Record<JobPriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };
    jobs.sort((a, b) => {
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    jobs = jobs.slice(0, limit);

    return new Response(JSON.stringify({
      jobs,
      total: this.jobs.size,
      filtered: jobs.length,
      metrics: this.metrics,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async createJob(request: Request): Promise<Response> {
    const body = await request.json() as Partial<AgentJob>;

    const job: AgentJob = {
      id: body.id || crypto.randomUUID(),
      type: body.type || 'sync_content',
      status: 'pending',
      priority: body.priority || 'normal',
      payload: body.payload || {},
      retryCount: 0,
      maxRetries: body.maxRetries || parseInt(this.env.MAX_RETRY_ATTEMPTS),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      healingAttempts: 0,
    };

    this.jobs.set(job.id, job);
    this.metrics.totalCreated++;

    // Queue the job for processing
    await this.env.JOBS_QUEUE.send(job);
    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      job,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async getJob(id: string): Promise<Response> {
    const job = this.jobs.get(id);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(job), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async updateJob(id: string, request: Request): Promise<Response> {
    const job = this.jobs.get(id);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const updates = await request.json() as Partial<AgentJob>;

    // Track status changes
    if (updates.status && updates.status !== job.status) {
      if (updates.status === 'completed') {
        this.metrics.totalCompleted++;
        job.completedAt = new Date().toISOString();
      } else if (updates.status === 'failed') {
        this.metrics.totalFailed++;
      } else if (updates.status === 'healing') {
        this.metrics.totalHealing++;
      }
    }

    // Apply updates
    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    this.jobs.set(id, job);
    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      job,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async deleteJob(id: string): Promise<Response> {
    if (!this.jobs.has(id)) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.jobs.delete(id);
    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      message: `Job ${id} deleted`,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async getMetrics(): Promise<Response> {
    const statusCounts: Record<JobStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      healing: 0,
    };

    for (const job of this.jobs.values()) {
      statusCounts[job.status]++;
    }

    return new Response(JSON.stringify({
      metrics: this.metrics,
      statusCounts,
      totalJobs: this.jobs.size,
      timestamp: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async cleanup(): Promise<Response> {
    const cutoffTime = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
    let cleaned = 0;

    for (const [id, job] of this.jobs.entries()) {
      if (job.status === 'completed' || job.status === 'failed') {
        const completedAt = job.completedAt
          ? new Date(job.completedAt).getTime()
          : new Date(job.updatedAt).getTime();

        if (completedAt < cutoffTime) {
          this.jobs.delete(id);
          cleaned++;
        }
      }
    }

    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      cleaned,
      remaining: this.jobs.size,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
