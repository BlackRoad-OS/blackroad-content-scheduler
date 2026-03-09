/**
 * GitHub Repository Scraper
 * Fetches and processes repository data from GitHub
 * ⬛⬜🛣️
 */

import type {
  Env,
  RepoData,
  RepoStructure,
  FileEntry,
  ConfigFile,
  ScrapeType,
  GitHubRepo,
  GitHubContent,
  CohesivenessScore,
} from '../types';

const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubScraper {
  private env: Env;
  private headers: HeadersInit;

  constructor(env: Env) {
    this.env = env;
    this.headers = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'BlackRoad-Content-Scheduler/1.0',
    };

    // Add auth token if available
    if (env.GITHUB_TOKEN) {
      this.headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
    }
  }

  /**
   * Scrape a repository
   */
  async scrapeRepo(
    fullName: string,
    scrapeType: ScrapeType,
    etag?: string
  ): Promise<RepoData | null> {
    console.log(`Scraping ${fullName} (type: ${scrapeType})`);

    try {
      // Fetch repo metadata
      const repoResponse = await this.fetchWithRetry(
        `${GITHUB_API_BASE}/repos/${fullName}`,
        etag ? { 'If-None-Match': etag } : {}
      );

      // Check if not modified
      if (repoResponse.status === 304) {
        console.log(`${fullName} not modified (etag match)`);
        return null;
      }

      if (!repoResponse.ok) {
        throw new Error(`GitHub API error: ${repoResponse.status} ${repoResponse.statusText}`);
      }

      const repoInfo = await repoResponse.json() as GitHubRepo;
      const newEtag = repoResponse.headers.get('ETag') || undefined;

      // Build repo data based on scrape type
      let structure: RepoStructure;

      if (scrapeType === 'metadata') {
        // Just metadata, use minimal structure
        structure = await this.getMinimalStructure(fullName);
      } else if (scrapeType === 'structure' || scrapeType === 'full') {
        // Full structure scan
        structure = await this.getFullStructure(fullName, repoInfo.default_branch);
      } else {
        // Incremental - check if we have cached structure
        const cached = await this.env.REPOS_KV.get(`repo:${fullName}`, 'json') as RepoData | null;
        structure = cached?.structure || await this.getMinimalStructure(fullName);
      }

      const repoData: RepoData = {
        fullName: repoInfo.full_name,
        name: repoInfo.name,
        description: repoInfo.description,
        defaultBranch: repoInfo.default_branch,
        language: repoInfo.language,
        topics: repoInfo.topics || [],
        visibility: repoInfo.visibility,
        structure,
        lastScrapedAt: new Date().toISOString(),
        etag: newEtag,
        cohesiveness: this.calculateInitialCohesiveness(structure),
      };

      return repoData;
    } catch (error) {
      console.error(`Error scraping ${fullName}:`, error);
      throw error;
    }
  }

  /**
   * Get minimal structure (just config files)
   */
  private async getMinimalStructure(fullName: string): Promise<RepoStructure> {
    const configFiles: ConfigFile[] = [];
    const files: FileEntry[] = [];

    // Check for standard config files
    const configPaths = ['package.json', 'wrangler.toml', 'tsconfig.json'];

    for (const path of configPaths) {
      try {
        const response = await this.fetchWithRetry(
          `${GITHUB_API_BASE}/repos/${fullName}/contents/${path}`
        );

        if (response.ok) {
          const content = await response.json() as GitHubContent;
          files.push({
            path: content.path,
            type: 'file',
            size: content.size,
            sha: content.sha,
          });

          configFiles.push({
            path: content.path,
            type: this.getConfigType(path),
          });
        }
      } catch {
        // File doesn't exist, continue
      }
    }

    return {
      files,
      directories: [],
      configFiles,
      hasPackageJson: configFiles.some((c) => c.type === 'package.json'),
      hasWranglerConfig: configFiles.some((c) => c.type === 'wrangler.toml'),
      hasTsConfig: configFiles.some((c) => c.type === 'tsconfig.json'),
      primaryLanguage: null,
    };
  }

  /**
   * Get full repository structure
   */
  private async getFullStructure(
    fullName: string,
    branch: string
  ): Promise<RepoStructure> {
    const files: FileEntry[] = [];
    const directories: string[] = [];
    const configFiles: ConfigFile[] = [];

    // Get tree recursively
    const treeResponse = await this.fetchWithRetry(
      `${GITHUB_API_BASE}/repos/${fullName}/git/trees/${branch}?recursive=1`
    );

    if (!treeResponse.ok) {
      console.warn(`Could not fetch tree for ${fullName}, using minimal structure`);
      return this.getMinimalStructure(fullName);
    }

    const tree = await treeResponse.json() as {
      tree: Array<{ path: string; type: string; sha: string; size?: number }>;
      truncated: boolean;
    };

    if (tree.truncated) {
      console.warn(`Tree truncated for ${fullName}, some files may be missing`);
    }

    // Process tree entries
    for (const entry of tree.tree) {
      if (entry.type === 'blob') {
        files.push({
          path: entry.path,
          type: 'file',
          size: entry.size,
          sha: entry.sha,
        });

        // Check for config files
        const basename = entry.path.split('/').pop() || '';
        if (this.isConfigFile(basename)) {
          configFiles.push({
            path: entry.path,
            type: this.getConfigType(basename),
          });
        }
      } else if (entry.type === 'tree') {
        directories.push(entry.path);
      }
    }

    // Detect primary language
    const languageStats = this.detectLanguages(files);
    const primaryLanguage = Object.entries(languageStats)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    return {
      files,
      directories,
      configFiles,
      hasPackageJson: configFiles.some((c) => c.type === 'package.json'),
      hasWranglerConfig: configFiles.some((c) => c.type === 'wrangler.toml'),
      hasTsConfig: configFiles.some((c) => c.type === 'tsconfig.json'),
      primaryLanguage,
    };
  }

  /**
   * Fetch with retry and backoff
   */
  private async fetchWithRetry(
    url: string,
    additionalHeaders: Record<string, string> = {},
    maxRetries = 3
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { ...this.headers, ...additionalHeaders },
        });

        // Handle rate limiting
        if (response.status === 403 || response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const waitTime = retryAfter
            ? parseInt(retryAfter) * 1000
            : Math.pow(2, attempt) * 1000;

          console.warn(`Rate limited, waiting ${waitTime}ms`);
          await this.sleep(waitTime);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const backoff = Math.pow(2, attempt) * 1000;
        console.warn(`Fetch attempt ${attempt + 1} failed, retrying in ${backoff}ms`);
        await this.sleep(backoff);
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * Check if file is a config file
   */
  private isConfigFile(filename: string): boolean {
    const configFiles = [
      'package.json',
      'wrangler.toml',
      'wrangler.json',
      'tsconfig.json',
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.json',
      '.prettierrc',
      '.prettierrc.js',
      '.prettierrc.json',
      'vitest.config.ts',
      'jest.config.js',
      'jest.config.ts',
    ];
    return configFiles.includes(filename) || filename.endsWith('.config.js') || filename.endsWith('.config.ts');
  }

  /**
   * Get config file type
   */
  private getConfigType(filename: string): ConfigFile['type'] {
    if (filename === 'package.json') return 'package.json';
    if (filename === 'wrangler.toml' || filename === 'wrangler.json') return 'wrangler.toml';
    if (filename === 'tsconfig.json') return 'tsconfig.json';
    return 'other';
  }

  /**
   * Detect languages from file extensions
   */
  private detectLanguages(files: FileEntry[]): Record<string, number> {
    const extensionMap: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript',
      '.py': 'Python',
      '.go': 'Go',
      '.rs': 'Rust',
      '.java': 'Java',
      '.rb': 'Ruby',
      '.php': 'PHP',
      '.cs': 'C#',
      '.cpp': 'C++',
      '.c': 'C',
      '.swift': 'Swift',
      '.kt': 'Kotlin',
    };

    const counts: Record<string, number> = {};

    for (const file of files) {
      const ext = '.' + file.path.split('.').pop();
      const language = extensionMap[ext];
      if (language) {
        counts[language] = (counts[language] || 0) + (file.size || 1);
      }
    }

    return counts;
  }

  /**
   * Calculate initial cohesiveness score
   */
  private calculateInitialCohesiveness(structure: RepoStructure): CohesivenessScore {
    let configScore = 100;
    const issues: CohesivenessScore['issues'] = [];

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
        suggestion: 'Add TypeScript configuration',
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

    const hasSrcDir = structure.directories.some(
      (d) => d === 'src' || d.startsWith('src/')
    );

    let structureScore = 100;
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

    return {
      overall: Math.round((configScore + structureScore + 100 + 100) / 4),
      structure: structureScore,
      naming: 100,
      dependencies: 100,
      config: configScore,
      lastCheckedAt: new Date().toISOString(),
      issues,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Discover all repos in an organization
 */
export async function discoverOrgRepos(
  org: string,
  env: Env
): Promise<string[]> {
  const headers: HeadersInit = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'BlackRoad-Content-Scheduler/1.0',
  };

  if (env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
  }

  const repos: string[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `${GITHUB_API_BASE}/orgs/${org}/repos?per_page=${perPage}&page=${page}`,
      { headers }
    );

    if (!response.ok) {
      console.error(`Failed to fetch org repos: ${response.status}`);
      break;
    }

    const data = await response.json() as GitHubRepo[];

    if (data.length === 0) {
      break;
    }

    for (const repo of data) {
      repos.push(repo.full_name);
    }

    if (data.length < perPage) {
      break;
    }

    page++;
  }

  return repos;
}
