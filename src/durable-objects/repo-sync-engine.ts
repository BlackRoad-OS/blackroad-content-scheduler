/**
 * Repo Sync Engine Durable Object
 * Manages repository synchronization and cohesiveness checking
 * ⬛⬜🛣️
 */

import type { Env, RepoData, SyncState, CohesivenessScore, CohesivenessIssue } from '../types';

interface SyncEngineState {
  repos: Record<string, RepoData>;
  lastFullSync: string | null;
  lastCohesivenessCheck: string | null;
  inProgress: boolean;
  errors: Array<{ repo: string; error: string; timestamp: string }>;
}

// Known BlackRoad repos to track
const BLACKROAD_REPOS = [
  'blackroad-prism-console',
  'blackroad-content-scheduler',
  'blackroad-os',
  'blackroad-cli',
  'blackroad-sdk',
  'blackroad-studio',
  'blackroad-api',
  'blackroad-dashboard',
  'blackroad-docs',
];

export class RepoSyncEngine implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private repos: Map<string, RepoData> = new Map();
  private lastFullSync: string | null = null;
  private lastCohesivenessCheck: string | null = null;
  private inProgress = false;
  private errors: Array<{ repo: string; error: string; timestamp: string }> = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<SyncEngineState>('state');
      if (stored) {
        this.repos = new Map(Object.entries(stored.repos || {}));
        this.lastFullSync = stored.lastFullSync;
        this.lastCohesivenessCheck = stored.lastCohesivenessCheck;
        this.errors = stored.errors || [];
      }
    });
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', {
      repos: Object.fromEntries(this.repos),
      lastFullSync: this.lastFullSync,
      lastCohesivenessCheck: this.lastCohesivenessCheck,
      inProgress: this.inProgress,
      errors: this.errors.slice(-100), // Keep last 100 errors
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /repos - List all repos
      if (path === '/repos' && request.method === 'GET') {
        return this.listRepos();
      }

      // GET /status - Get sync status
      if (path === '/status' && request.method === 'GET') {
        return this.getStatus();
      }

      // POST /sync/full - Trigger full sync
      if (path === '/sync/full' && request.method === 'POST') {
        return this.triggerFullSync();
      }

      // POST /sync/cohesiveness - Trigger cohesiveness check
      if (path === '/sync/cohesiveness' && request.method === 'POST') {
        return this.triggerCohesivenessCheck();
      }

      // POST /sync/repo - Sync specific repo
      if (path === '/sync/repo' && request.method === 'POST') {
        const body = await request.json() as { repoName: string };
        return this.syncRepo(body.repoName);
      }

      // GET /cohesiveness - Get overall cohesiveness
      if (path === '/cohesiveness' && request.method === 'GET') {
        return this.getCohesivenessReport();
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('RepoSyncEngine error:', error);
      return new Response(JSON.stringify({
        error: 'Internal error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async listRepos(): Promise<Response> {
    const repos = Array.from(this.repos.values());

    return new Response(JSON.stringify({
      repos,
      total: repos.length,
      knownRepos: BLACKROAD_REPOS,
      lastSync: this.lastFullSync,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async getStatus(): Promise<Response> {
    return new Response(JSON.stringify({
      inProgress: this.inProgress,
      lastFullSync: this.lastFullSync,
      lastCohesivenessCheck: this.lastCohesivenessCheck,
      repoCount: this.repos.size,
      recentErrors: this.errors.slice(-10),
      timestamp: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async triggerFullSync(): Promise<Response> {
    if (this.inProgress) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Sync already in progress',
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.inProgress = true;
    await this.persist();

    // Queue scrape tasks for all known repos
    const org = this.env.BLACKROAD_ORG || 'BlackRoad-OS';
    for (const repoName of BLACKROAD_REPOS) {
      await this.env.SCRAPE_QUEUE.send({
        id: crypto.randomUUID(),
        repoFullName: `${org}/${repoName}`,
        scrapeType: 'full',
        priority: 'normal',
      });
    }

    this.lastFullSync = new Date().toISOString();
    this.inProgress = false;
    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      message: 'Full sync triggered',
      repos: BLACKROAD_REPOS.length,
      timestamp: this.lastFullSync,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async triggerCohesivenessCheck(): Promise<Response> {
    const results: Array<{ repo: string; score: CohesivenessScore }> = [];

    for (const [repoName, repoData] of this.repos.entries()) {
      const score = this.calculateCohesiveness(repoData);
      results.push({ repo: repoName, score });

      // Update repo data with new score
      repoData.cohesiveness = score;
      this.repos.set(repoName, repoData);

      // Store in KV for quick access
      await this.env.REPOS_KV.put(
        `cohesiveness:${repoName}`,
        JSON.stringify(score),
        { expirationTtl: 3600 }
      );
    }

    this.lastCohesivenessCheck = new Date().toISOString();
    await this.persist();

    // Queue healing tasks for critical issues
    for (const result of results) {
      const criticalIssues = result.score.issues.filter(
        (i) => i.severity === 'critical' && i.autoFixable
      );
      if (criticalIssues.length > 0) {
        await this.env.HEALING_QUEUE.send({
          id: crypto.randomUUID(),
          jobId: `cohesiveness-${result.repo}`,
          issue: {
            type: 'cohesiveness_issues',
            severity: 'high',
            description: `${criticalIssues.length} critical cohesiveness issues in ${result.repo}`,
            context: { issues: criticalIssues, repo: result.repo },
          },
          strategy: 'escalate_to_agent',
          attempts: 0,
          maxAttempts: 3,
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      results,
      timestamp: this.lastCohesivenessCheck,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async syncRepo(repoName: string): Promise<Response> {
    await this.env.SCRAPE_QUEUE.send({
      id: crypto.randomUUID(),
      repoFullName: repoName,
      scrapeType: 'full',
      priority: 'high',
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Sync queued for ${repoName}`,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private calculateCohesiveness(repo: RepoData): CohesivenessScore {
    const issues: CohesivenessIssue[] = [];
    let structureScore = 100;
    let namingScore = 100;
    let depsScore = 100;
    let configScore = 100;

    const structure = repo.structure;

    // Check for standard config files
    if (!structure.hasPackageJson) {
      configScore -= 30;
      issues.push({
        type: 'missing_config',
        severity: 'warning',
        message: 'Missing package.json',
        suggestion: 'Add package.json for dependency management',
        autoFixable: true,
      });
    }

    if (!structure.hasTsConfig) {
      configScore -= 20;
      issues.push({
        type: 'missing_config',
        severity: 'info',
        message: 'Missing tsconfig.json',
        suggestion: 'Add TypeScript configuration for type safety',
        autoFixable: true,
      });
    }

    if (!structure.hasWranglerConfig) {
      configScore -= 25;
      issues.push({
        type: 'missing_config',
        severity: 'warning',
        message: 'Missing wrangler.toml',
        suggestion: 'Add Cloudflare Workers configuration',
        autoFixable: true,
      });
    }

    // Check naming conventions
    const hasSrcDir = structure.directories.some((d) => d === 'src' || d.startsWith('src/'));
    if (!hasSrcDir && structure.files.length > 5) {
      structureScore -= 20;
      issues.push({
        type: 'structure_mismatch',
        severity: 'info',
        message: 'No src/ directory found',
        suggestion: 'Consider organizing source files in src/',
        autoFixable: false,
      });
    }

    // Check for README
    const hasReadme = structure.files.some(
      (f) => f.path.toLowerCase() === 'readme.md'
    );
    if (!hasReadme) {
      structureScore -= 10;
      issues.push({
        type: 'missing_config',
        severity: 'info',
        message: 'Missing README.md',
        suggestion: 'Add documentation',
        autoFixable: true,
      });
    }

    // Calculate overall score
    const overall = Math.round(
      (structureScore + namingScore + depsScore + configScore) / 4
    );

    return {
      overall,
      structure: structureScore,
      naming: namingScore,
      dependencies: depsScore,
      config: configScore,
      lastCheckedAt: new Date().toISOString(),
      issues,
    };
  }

  private async getCohesivenessReport(): Promise<Response> {
    const report: Array<{
      repo: string;
      score: CohesivenessScore | null;
    }> = [];

    for (const [repoName, repoData] of this.repos.entries()) {
      report.push({
        repo: repoName,
        score: repoData.cohesiveness || null,
      });
    }

    // Calculate aggregate stats
    const scores = report.filter((r) => r.score).map((r) => r.score!.overall);
    const avgScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;

    const allIssues = report
      .filter((r) => r.score)
      .flatMap((r) => r.score!.issues);

    const issueSummary = {
      critical: allIssues.filter((i) => i.severity === 'critical').length,
      warning: allIssues.filter((i) => i.severity === 'warning').length,
      info: allIssues.filter((i) => i.severity === 'info').length,
      autoFixable: allIssues.filter((i) => i.autoFixable).length,
    };

    return new Response(JSON.stringify({
      repos: report,
      summary: {
        totalRepos: this.repos.size,
        averageScore: avgScore,
        issueSummary,
        lastCheck: this.lastCohesivenessCheck,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Called by scraper to update repo data
  async updateRepo(repoData: RepoData): Promise<void> {
    this.repos.set(repoData.fullName, repoData);
    await this.env.REPOS_KV.put(
      `repo:${repoData.fullName}`,
      JSON.stringify(repoData)
    );
    await this.persist();
  }
}
