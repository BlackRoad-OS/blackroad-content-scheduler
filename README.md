# blackroad-content-scheduler

⬛⬜🛣️ **Agent Jobs, Scraping & Self-Healing System for Cloudflare Workers**

Part of the BlackRoad Product Suite - 100+ tools for modern development.

## Features

- **Agent Job System** - Queue-based async job processing with priority scheduling
- **Repo Scraping** - Automated scraping of BlackRoad repos via GitHub API
- **Cohesiveness Engine** - Cross-repo consistency checking and scoring
- **Self-Healing** - Automatic issue detection and resolution with escalation
- **Durable Objects** - Persistent state coordination across workers
- **Cron Scheduling** - Automated maintenance and sync tasks

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers Edge                          │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │   HTTP API  │  │    Cron     │  │   Queues    │                 │
│  │   (Hono)    │  │  Triggers   │  │ Processors  │                 │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                 │
│         │                │                │                         │
│  ┌──────┴────────────────┴────────────────┴──────┐                 │
│  │              Durable Objects                   │                 │
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────┐ │                 │
│  │  │     Job      │ │   Repo Sync  │ │  Self  │ │                 │
│  │  │ Coordinator  │ │    Engine    │ │ Healer │ │                 │
│  │  └──────────────┘ └──────────────┘ └────────┘ │                 │
│  └───────────────────────────────────────────────┘                 │
│         │                │                │                         │
│  ┌──────┴────────────────┴────────────────┴──────┐                 │
│  │                  Storage                       │                 │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │                 │
│  │  │CONTENT │ │  JOBS  │ │ REPOS  │ │HEALING │  │                 │
│  │  │   KV   │ │   KV   │ │   KV   │ │   KV   │  │                 │
│  │  └────────┘ └────────┘ └────────┘ └────────┘  │                 │
│  └───────────────────────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account

### Installation

```bash
# Clone the repo
git clone https://github.com/BlackRoad-OS/blackroad-content-scheduler.git
cd blackroad-content-scheduler

# Install dependencies
npm install

# Configure wrangler (login to Cloudflare)
wrangler login

# Create KV namespaces
wrangler kv:namespace create content-scheduler-kv
wrangler kv:namespace create agent-jobs-kv
wrangler kv:namespace create repos-cache-kv
wrangler kv:namespace create self-healing-kv

# Update wrangler.toml with your namespace IDs
```

### Development

```bash
# Start local development server
npm run dev

# Type checking
npm run typecheck

# Run tests
npm test
```

### Deployment

```bash
# Deploy to Cloudflare Workers
npm run deploy
```

## API Reference

### Jobs API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/jobs` | GET | List all jobs |
| `/api/jobs` | POST | Create a new job |
| `/api/jobs/:id` | GET | Get job by ID |
| `/api/jobs/:id` | PUT | Update job |

### Repos API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/repos` | GET | List tracked repos |
| `/api/repos/:owner/:name` | GET | Get repo data |
| `/api/repos/:owner/:name/scrape` | POST | Trigger repo scrape |
| `/api/repos/:owner/:name/cohesiveness` | GET | Get cohesiveness score |

### Sync API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sync/status` | GET | Get sync status |
| `/api/sync/full` | POST | Trigger full sync |
| `/api/sync/cohesiveness` | POST | Trigger cohesiveness check |

### Healing API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/healing/status` | GET | Get healer status |
| `/api/healing/tasks` | GET | List healing tasks |
| `/api/healing/trigger` | POST | Trigger manual healing |
| `/api/healing/metrics` | GET | Get healing metrics |

## Self-Healing Strategies

The self-healing system uses a progressive escalation approach:

1. **retry_with_backoff** - Retry with exponential backoff (1s, 2s, 4s, 8s, 16s)
2. **clear_cache_retry** - Clear related caches and retry
3. **switch_endpoint** - Switch to backup API endpoint
4. **reduce_batch_size** - Reduce batch size and retry
5. **notify_and_skip** - Log issue and continue
6. **full_reset** - Reset state and re-queue
7. **escalate_to_agent** - Escalate for manual intervention

## Cron Schedules

| Schedule | Task |
|----------|------|
| `*/30 * * * *` | Incremental repo scraping |
| `0 * * * *` | Cohesiveness check |
| `*/5 * * * *` | Self-healing check |
| `0 0 * * *` | Daily maintenance & cleanup |

## Configuration

Environment variables in `wrangler.toml`:

| Variable | Description | Default |
|----------|-------------|---------|
| `ENVIRONMENT` | Environment name | development |
| `BLACKROAD_ORG` | GitHub org to scrape | BlackRoad-OS |
| `SCRAPE_INTERVAL_MINUTES` | Scrape interval | 30 |
| `SELF_HEAL_ENABLED` | Enable self-healing | true |
| `MAX_RETRY_ATTEMPTS` | Max job retries | 5 |
| `GITHUB_TOKEN` | GitHub API token (optional) | - |

## Tracked Repos

The system automatically tracks these BlackRoad repos:

- `blackroad-prism-console`
- `blackroad-content-scheduler`
- `blackroad-os`
- `blackroad-cli`
- `blackroad-sdk`
- `blackroad-studio`
- `blackroad-api`
- `blackroad-dashboard`
- `blackroad-docs`

## About BlackRoad

BlackRoad OS is building the future of development tools and infrastructure.

⬛⬜🛣️ **Built with BlackRoad**
