/**
 * BlackRoad Content Scheduler - Type Definitions
 * ⬛⬜🛣️
 */

// Environment bindings
export interface Env {
  // KV Namespaces
  CONTENT_KV: KVNamespace;
  JOBS_KV: KVNamespace;
  REPOS_KV: KVNamespace;
  HEALING_KV: KVNamespace;

  // Durable Objects
  JOB_COORDINATOR: DurableObjectNamespace;
  REPO_SYNC_ENGINE: DurableObjectNamespace;
  SELF_HEALER: DurableObjectNamespace;

  // Queues
  JOBS_QUEUE: Queue<AgentJob>;
  SCRAPE_QUEUE: Queue<ScrapeTask>;
  HEALING_QUEUE: Queue<HealingTask>;

  // R2 Bucket
  CONTENT_BUCKET: R2Bucket;

  // Environment variables
  ENVIRONMENT: string;
  BLACKROAD_ORG: string;
  SCRAPE_INTERVAL_MINUTES: string;
  SELF_HEAL_ENABLED: string;
  MAX_RETRY_ATTEMPTS: string;
  GITHUB_TOKEN?: string;
}

// Agent Job System
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'healing';
export type JobPriority = 'critical' | 'high' | 'normal' | 'low';

export interface AgentJob {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: JobPriority;
  payload: JobPayload;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  result?: unknown;
  healingAttempts: number;
}

export type JobType =
  | 'scrape_repo'
  | 'sync_content'
  | 'check_cohesiveness'
  | 'self_heal'
  | 'update_cache'
  | 'full_sync'
  | 'cleanup'
  | 'notify';

export interface JobPayload {
  repoName?: string;
  targetRepos?: string[];
  force?: boolean;
  source?: string;
  metadata?: Record<string, unknown>;
}

// Scraping System
export interface ScrapeTask {
  id: string;
  repoFullName: string;
  scrapeType: ScrapeType;
  lastScrapeAt?: string;
  etag?: string;
  priority: JobPriority;
}

export type ScrapeType = 'full' | 'incremental' | 'structure' | 'content' | 'metadata';

export interface RepoData {
  fullName: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  language: string | null;
  topics: string[];
  visibility: string;
  structure: RepoStructure;
  lastScrapedAt: string;
  etag?: string;
  cohesiveness: CohesivenessScore;
}

export interface RepoStructure {
  files: FileEntry[];
  directories: string[];
  configFiles: ConfigFile[];
  hasPackageJson: boolean;
  hasWranglerConfig: boolean;
  hasTsConfig: boolean;
  primaryLanguage: string | null;
}

export interface FileEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  sha?: string;
}

export interface ConfigFile {
  path: string;
  type: 'package.json' | 'wrangler.toml' | 'tsconfig.json' | 'other';
  content?: Record<string, unknown>;
}

// Cohesiveness System
export interface CohesivenessScore {
  overall: number; // 0-100
  structure: number;
  naming: number;
  dependencies: number;
  config: number;
  lastCheckedAt: string;
  issues: CohesivenessIssue[];
}

export interface CohesivenessIssue {
  type: IssueType;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  path?: string;
  suggestion?: string;
  autoFixable: boolean;
}

export type IssueType =
  | 'missing_config'
  | 'outdated_dependency'
  | 'naming_inconsistency'
  | 'structure_mismatch'
  | 'missing_type_definitions'
  | 'deprecated_pattern';

// Self-Healing System
export interface HealingTask {
  id: string;
  jobId: string;
  issue: HealingIssue;
  strategy: HealingStrategy;
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'attempting' | 'resolved' | 'escalated';
  resolution?: HealingResolution;
  createdAt: string;
  updatedAt: string;
}

export interface HealingIssue {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  context: Record<string, unknown>;
  originalError?: string;
  stackTrace?: string;
}

export type HealingStrategy =
  | 'retry_with_backoff'
  | 'clear_cache_retry'
  | 'switch_endpoint'
  | 'reduce_batch_size'
  | 'notify_and_skip'
  | 'full_reset'
  | 'escalate_to_agent';

export interface HealingResolution {
  strategy: HealingStrategy;
  success: boolean;
  message: string;
  attemptNumber: number;
  resolvedAt: string;
  metrics?: {
    timeToResolve: number;
    resourcesUsed: number;
  };
}

// Sync Engine
export interface SyncState {
  lastFullSyncAt: string;
  lastIncrementalSyncAt: string;
  repos: Map<string, RepoSyncState>;
  inProgress: boolean;
  errors: SyncError[];
}

export interface RepoSyncState {
  repoName: string;
  lastSyncedCommit: string;
  lastSyncedAt: string;
  syncStatus: 'synced' | 'pending' | 'error';
  errorCount: number;
}

export interface SyncError {
  repoName: string;
  error: string;
  timestamp: string;
  resolved: boolean;
}

// Cron Schedule
export interface CronJob {
  name: string;
  schedule: string;
  handler: (env: Env) => Promise<void>;
  enabled: boolean;
}

// API Responses
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    timestamp: string;
    requestId: string;
  };
}

// GitHub API Types
export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  language: string | null;
  topics: string[];
  visibility: string;
  html_url: string;
  clone_url: string;
  updated_at: string;
  pushed_at: string;
}

export interface GitHubContent {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  download_url: string | null;
}
