# X-Ray: Decision Observability for Algorithmic Pipelines

## What This System Is

X-Ray is a decision observability system for multi-step, non-deterministic algorithmic pipelines. It answers one question: **"Why did the system make this decision?"**

### What This System Is NOT

- **Not tracing**: We track decision boundaries, not execution spans. Latency and call graphs are out of scope.
- **Not logging**: Structured decision artifacts, not free-form text logs.
- **Not metrics**: Step-level metrics are normalized and queryable, not aggregated time-series.
- **Not model monitoring**: We explain decisions, not model performance over time.

Confusing these is dangerous because it leads to:
- Over-instrumentation (capturing everything)
- Unqueryable data (logs that can't answer "why")
- Wrong abstractions (execution time vs decision quality)

## Core Principles

1. **Decision observability > execution observability**: We model why decisions were made, not how long they took.
2. **Queryability beats flexibility**: Rigid schemas enable cross-pipeline queries.
3. **Defaults must be safe**: Minimal capture by default, opt-in for verbosity.
4. **Instrumentation must never break the pipeline**: SDK degrades to no-op if backend is unavailable.
5. **Boring tech + clear abstractions > cleverness**: PostgreSQL, REST APIs, no exotic tech.
6. **Explicit trade-offs > pretending something is perfect**: Acknowledge limitations upfront.

## Deployment and Scope

**Deployment, networking, and service hosting are intentionally out of scope for this reference implementation.**

X-Ray is designed as an internal or local service. The deployment environment, networking configuration, DNS, and infrastructure setup are not specified. This design focuses on decision observability architecture and data models, not operational deployment.

**Authentication is intentionally omitted.** In a production deployment, service-level authentication (API keys or mTLS) would be used to protect ingestion and query endpoints. For this reference implementation, authentication is not required to evaluate the decision observability design.

**Database choice:** PostgreSQL is used as the reference datastore to prioritize structured, queryable decision data over flexible but unstructured storage. Optional object storage may be mentioned for large artifacts, but the core schema assumes PostgreSQL with JSONB support.

## Conceptual Model

### 1. Run

A Run represents one execution of a pipeline.

**Required fields:**
- `run_id` (UUID, primary key)
- `pipeline_name` (string, indexed)
- `pipeline_version` (string, indexed)
- `environment` (string: dev/staging/prod, defaults to prod if not specified)
- `started_at`, `ended_at` (timestamps)
- `metadata` (opaque JSON, non-indexed)

**Rationale:**
- Runs are the atomic unit of debugging. All queries roll up to runs.
- Versioning enables comparing behavior across pipeline iterations.
- Environment separation enables comparing behavior across different deployment contexts.

### 2. Step

A Step represents a semantic decision boundary.

**Required fields:**
- `step_id` (UUID, primary key)
- `run_id` (UUID, foreign key)
- `step_type` (enum, indexed)
- `step_name` (string, indexed)
- `position` (integer, ordered within run)
- `metrics` (normalized key-value, indexed)
- `candidates_in` (count)
- `candidates_out` (count)
- `drop_ratio` (computed: 1 - candidates_out/candidates_in)
- `capture_level` (enum: NONE/SUMMARY/FULL)
- `artifacts` (typed JSON per step_type)
- `started_at`, `ended_at` (timestamps)

**Step Types (strict enum):**
- `INPUT`: Initial candidate generation
- `GENERATION`: LLM or heuristic-based generation
- `RETRIEVAL`: External data fetch (vector DB, knowledge base)
- `FILTER`: Candidate elimination
- `RANKING`: Score-based ordering
- `EVALUATION`: Quality assessment
- `SELECTION`: Final choice

**Why step typing is enforced:**
- Enables cross-pipeline queries: "Show all FILTER steps that dropped >90%"
- Prevents arbitrary strings that break queryability
- Allows type-specific artifact schemas

**What breaks if step types are free-form:**
- Cannot query across pipelines reliably
- Artifact schemas become untyped blobs
- Metric normalization fails

### 3. Candidate

A Candidate represents an option considered by the system.

**Key properties:**
- `candidate_id` (stable within run)
- `step_id` (where it appears)
- `content` (summary or full, depending on capture_level)
- `metadata` (scores, reasons, flags)

**Why candidates are first-class:**
- Enables tracking: "Which candidates survived all filters?"
- Allows sampling strategies: capture full content for top N only
- Supports redaction: sensitive data can be masked

Candidates are persisted only for FULL capture to prevent unbounded storage growth while preserving deep debuggability when explicitly requested.

### 4. Decision Artifacts

Structured explanation of why something happened.

**Examples:**
- FILTER: `{ "rules": ["price > 100", "in_stock = true"], "rejected_count": 450 }`
- RANKING: `{ "scores": { "relevance": 0.95, "quality": 0.82 }, "method": "weighted_sum" }`
- GENERATION: `{ "model": "gpt-4", "reasoning_summary": "Selected top 3 based on keyword match", "tokens_used": 1200 }`

**Properties:**
- Structured (typed per step_type)
- Optional (only if capture_level allows)
- Not free-form JSON (enforced schemas)

## Data Model

### Step-Centric Schema

```sql
-- Runs table
CREATE TABLE runs (
  run_id UUID PRIMARY KEY,
  pipeline_name VARCHAR(255) NOT NULL,
  pipeline_version VARCHAR(100) NOT NULL,
  environment VARCHAR(50) NOT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  metadata JSONB
);

CREATE INDEX idx_runs_pipeline ON runs(pipeline_name, pipeline_version);
CREATE INDEX idx_runs_environment ON runs(environment, started_at);

-- Steps table
CREATE TABLE steps (
  step_id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_type VARCHAR(50) NOT NULL,
  step_name VARCHAR(255) NOT NULL,
  position INTEGER NOT NULL,
  metrics JSONB NOT NULL,
  candidates_in INTEGER NOT NULL,
  candidates_out INTEGER NOT NULL,
  drop_ratio DECIMAL(5,4),
  capture_level VARCHAR(20) NOT NULL,
  artifacts JSONB,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP
);

CREATE INDEX idx_steps_run ON steps(run_id, position);
CREATE INDEX idx_steps_type ON steps(step_type, drop_ratio);
CREATE INDEX idx_steps_metrics ON steps USING GIN(metrics);

-- Candidates table (only if capture_level = FULL)
CREATE TABLE candidates (
  candidate_id VARCHAR(255) NOT NULL,
  step_id UUID NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  content TEXT,
  metadata JSONB,
  PRIMARY KEY (candidate_id, step_id)
);

CREATE INDEX idx_candidates_step ON candidates(step_id);
```

**Why this is NOT a free-form JSON event log:**
- Normalized metrics enable queries: `WHERE metrics->>'rejection_reason' = 'price_too_high'`
- Step typing enables aggregation: `GROUP BY step_type, drop_ratio`
- Schema rigidity enables cross-pipeline analysis

**What flexibility is intentionally sacrificed:**
- Cannot add arbitrary fields to steps without migration
- Artifacts must conform to step_type schemas
- Candidates are only captured at FULL capture_level

## Queryability Guarantees

### Example Queries

**"Show all runs where ANY filter step eliminated more than 90% of candidates"**
```sql
SELECT DISTINCT r.run_id, r.pipeline_name, s.step_name, s.drop_ratio
FROM runs r
JOIN steps s ON r.run_id = s.run_id
WHERE s.step_type = 'FILTER' AND s.drop_ratio > 0.9;
```

**"Find ranking steps with inconsistent score distributions"**
```sql
SELECT step_id, step_name, metrics->>'score_variance' as variance
FROM steps
WHERE step_type = 'RANKING' 
  AND (metrics->>'score_variance')::float > 0.5;
```

**How step typing enables this:**
- `step_type = 'FILTER'` filters to relevant steps only
- Cross-pipeline queries work because types are consistent

**How metric normalization enables this:**
- `metrics->>'rejection_reason'` works across all FILTER steps
- Developers must use normalized keys (enforced by SDK)

**What is enforced vs documented:**
- **Enforced**: Step types (enum), metric keys (SDK validation)
- **Documented**: Artifact schemas per type, capture_level semantics

**Limitations:**
- False positives: High drop_ratio may be intentional (e.g., strict filters)
- Edge cases: If candidates_in = 0, drop_ratio is treated as NULL and excluded from ratio-based queries
- Metric keys must be known: Cannot query unknown metrics

## Performance & Scale

### Scenario: 5,000 candidates → 30 survivors

**Storage cost:**
- SUMMARY capture: ~1KB per step (metrics + counts only)
- FULL capture: ~50KB per candidate × 5,000 = 250MB per step
- **Strategy**: Default to SUMMARY, opt-in to FULL for top N candidates only

**Serialization overhead:**
- Artifacts are typed JSON, not raw blobs
- Candidates are sampled: capture full content for top 10% only

**Network overhead:**
- Async ingestion: SDK buffers and sends in batches
- Compression: gzip for large payloads

**Latency sensitivity:**
- SDK is fire-and-forget: no blocking on backend
- Backend processes asynchronously

**Capture policies:**
- **Default (NONE)**: Only step metadata, no candidates
- **SUMMARY**: Metrics + counts + artifact summaries
- **FULL**: All candidates with full content (opt-in per step)

**What requires opt-in:**
- FULL capture_level
- Candidate content (not just IDs)
- Detailed reasoning summaries

**What is never captured automatically:**
- Raw LLM tokens (only summaries)
- Full candidate content at SUMMARY level
- External API responses (only relevant fields)

## SDK Design

### Minimal Example

```typescript
import { xray, StepType, CaptureLevel } from '@xray/core';

const result = await xray.run('competitor-selection', 'v1.0.0', async () => {
  const candidates = await xray.step(StepType.INPUT, 'fetch-products', async () => {
    return await fetchProducts();
  });

  const filtered = await xray.step(StepType.FILTER, 'price-filter', async () => {
    return candidates.filter(p => p.price < 100);
  }, {
    captureLevel: CaptureLevel.SUMMARY,
    artifacts: { threshold: 100, rule: 'price < 100' }
  });

  return filtered;
});
```

### Full Instrumentation

```typescript
const ranked = await xray.step(StepType.RANKING, 'relevance-score', async () => {
  return candidates.map(c => ({
    ...c,
    score: calculateScore(c)
  })).sort((a, b) => b.score - a.score);
}, {
  captureLevel: CaptureLevel.FULL,
  candidates: candidates.map(c => ({ candidateId: c.id, content: c })),
  artifacts: {
    method: 'weighted_sum',
    weights: { relevance: 0.7, quality: 0.3 },
    scores: candidates.map(c => ({ id: c.id, score: calculateScore(c) }))
  }
});
```

### Degradation Behavior

If X-Ray backend is unavailable:
- SDK logs warning once
- All `xray.step()` calls become no-ops
- Pipeline continues normally
- No exceptions thrown

## Backend API

### Ingest Endpoints

**POST /api/v1/runs**
```json
{
  "run_id": "uuid",
  "pipeline_name": "competitor-selection",
  "pipeline_version": "v2.1.0",
  "environment": "prod",
  "started_at": "2024-01-15T10:00:00Z"
}
```

**POST /api/v1/steps**
```json
{
  "step_id": "uuid",
  "run_id": "uuid",
  "step_type": "FILTER",
  "step_name": "price-filter",
  "position": 2,
  "metrics": { "rejection_reason": "price_too_high", "count": 450 },
  "candidates_in": 500,
  "candidates_out": 50,
  "drop_ratio": 0.9,
  "capture_level": "SUMMARY",
  "artifacts": { "threshold": 100, "rule": "price < 100" },
  "started_at": "2024-01-15T10:00:05Z",
  "ended_at": "2024-01-15T10:00:06Z"
}
```

**POST /api/v1/candidates** (batch, only if capture_level = FULL)
```json
{
  "step_id": "uuid",
  "candidates": [
    { "candidate_id": "prod-123", "content": "...", "metadata": {} }
  ]
}
```

### Query Endpoints

**GET /api/v1/runs/:run_id**
Returns full run with all steps.

**GET /api/v1/runs?pipeline_name=X&step_type=FILTER&min_drop_ratio=0.9**
Filter runs by step metrics.

**GET /api/v1/steps?run_id=X**
Get all steps for a run.

**GET /api/v1/steps/:step_id/candidates**
Get candidates for a step (if captured).

### Indexing Strategy

- Primary: `(run_id, position)` for step ordering
- Secondary: `(step_type, drop_ratio)` for cross-pipeline queries
- GIN index on `metrics` JSONB for key-value queries
- Time-based partitioning on `started_at` for retention

### Storage Assumptions

- PostgreSQL for structured queries (runs, steps)
- Optional: S3 for large candidate blobs (if FULL capture)
- Retention: 90 days default, configurable per environment

## Debugging Walkthrough

### Example: Phone case matched against laptop stand

**1. Inspect run**
```
GET /api/v1/runs/abc-123
→ Pipeline: product-matcher, Version: v1.2.0, Environment: prod
```

**2. Inspect steps**
```
Step 1: INPUT - "fetch-candidates"
  candidates_in: 0, candidates_out: 5000

Step 2: GENERATION - "keyword-extraction"
  candidates_in: 5000, candidates_out: 5000
  artifacts: { model: "gpt-4", reasoning_summary: "Extracted keywords from product titles" }

Step 3: FILTER - "category-match"
  candidates_in: 5000, candidates_out: 4500
  drop_ratio: 0.1
  artifacts: { rule: "category must match", rejected: 500 }

Step 4: RANKING - "relevance-score"
  candidates_in: 4500, candidates_out: 4500
  artifacts: { method: "cosine_similarity", top_score: 0.95 }

Step 5: SELECTION - "top-10"
  candidates_in: 4500, candidates_out: 10
  drop_ratio: 0.998
```

**3. Identify failure**
- Step 2 (GENERATION): Keywords extracted incorrectly
  - Artifact shows: "phone case" → ["phone", "case", "protection"]
  - Should have matched "laptop stand" category, but didn't
- Step 3 (FILTER): Over-aggressive category filter
  - Dropped 500 candidates, but phone case should have passed
- Step 4 (RANKING): Score was high (0.95) but irrelevant
  - Cosine similarity matched on "phone" keyword, not product type

**4. Root cause**
- Keyword extraction (GENERATION) failed to identify product type
- Category filter (FILTER) was too strict
- Ranking (RANKING) optimized for keyword match, not semantic similarity

**Fix**: Update GENERATION step to include product type detection, relax FILTER rules, adjust RANKING weights.

## Real-World Retrofit

### System: E-commerce Search Ranking Pipeline

**What existed:**
- Multi-stage pipeline: query expansion → candidate retrieval → filtering → ranking → selection
- Non-deterministic: LLM-based query expansion, learned ranking model
- Pain point: Bad results (irrelevant products ranked high) with no explanation

**Why logs failed:**
- Logs showed "retrieved 1000 candidates, ranked, returned top 10"
- No visibility into:
  - Which filters eliminated good candidates
  - Why ranking model scored irrelevant items high
  - What the LLM expanded the query to

**How X-Ray would have helped:**
- **Time to root cause**: 2 hours → 5 minutes
- **Query**: "Show all runs where FILTER steps dropped >80% and final selection had low relevance scores"
- **Finding**: Query expansion (GENERATION) was adding irrelevant keywords, causing retrieval (RETRIEVAL) to fetch wrong category, but ranking (RANKING) still scored them high due to keyword overlap

**Retrofit approach:**
1. Wrap existing functions with `xray.step()`
2. Start with SUMMARY capture (no performance impact)
3. Add FULL capture for ranking step only (most critical)
4. Query across runs to find patterns

## Forward-Looking (Not Implemented)

- **Privacy & redaction**: PII masking in candidate content, configurable redaction rules
- **Access control**: Per-pipeline permissions, audit logs
- **Cost governance**: Capture level quotas, automatic downgrade to SUMMARY if quota exceeded
- **Visualization layer**: Step-by-step decision tree, candidate flow diagrams
- **Schema evolution**: Versioned artifact schemas, migration tools
- **LLM-specific explainability**: Token-level attention (if model supports), reasoning chain extraction

## Trade-offs Acknowledged

1. **Schema rigidity**: Cannot add arbitrary fields without migration. Trade-off: Queryability.
2. **Capture overhead**: FULL capture is expensive. Trade-off: Opt-in only, sampling strategies.
3. **No real-time guarantees**: Async ingestion means slight delay. Trade-off: Non-blocking SDK.
4. **Step typing enforcement**: Developers must use enum values. Trade-off: Cross-pipeline queries.
5. **Metric normalization**: Must use known keys. Trade-off: Structured queries.

## Out of Scope (Explicitly)

- UI dashboards (acknowledged, not built)
- Real-time streaming guarantees
- Authentication, authorization, billing, tenancy
- Model training or evaluation
- Distributed tracing / latency analysis
- Service deployment, networking, and infrastructure
- Operational concerns (backups, monitoring, scaling)

