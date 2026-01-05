# X-Ray Architecture

Decision observability for multi-step algorithmic pipelines.

## The Problem

Pipelines that combine LLMs, filters, and ranking algorithms are hard to debug. When the output is wrong, traditional logs tell you what happened but not why a decision was made.

X-Ray captures decision context at each step so you can trace back from a bad output to the exact step that failed.

## System Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           YOUR PIPELINE                                  │
│  ┌────────┐   ┌──────────┐   ┌────────┐   ┌─────────┐   ┌──────────┐   │
│  │ INPUT  │──▶│GENERATION│──▶│ FILTER │──▶│ RANKING │──▶│SELECTION │   │
│  └───┬────┘   └────┬─────┘   └───┬────┘   └────┬────┘   └────┬─────┘   │
└──────┼─────────────┼─────────────┼─────────────┼─────────────┼──────────┘
       ▼             ▼             ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         X-RAY SDK                                        │
│  xray.step() wraps each step, captures context, sends to backend         │
└─────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         X-RAY API                                        │
│  Ingest: POST /runs, /steps, /candidates                                 │
│  Query:  GET /runs, /steps, /analytics                                   │
└─────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DATABASE                                         │
│  runs → steps → candidates                                               │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data Model

```
RUN
├── run_id (UUID)
├── pipeline_name (indexed)
├── pipeline_version
├── environment (dev/staging/prod)
├── started_at, ended_at
└── metadata (JSON)

STEP
├── step_id (UUID)
├── run_id (FK)
├── step_type (enum: INPUT, GENERATION, RETRIEVAL, FILTER, RANKING, EVALUATION, SELECTION)
├── step_name
├── position (order within run)
├── candidates_in, candidates_out
├── drop_ratio (computed)
├── capture_level (NONE, SUMMARY, FULL)
├── metrics (JSON, indexed)
└── artifacts (JSON)

CANDIDATE (only stored when capture_level = FULL)
├── candidate_id
├── step_id (FK)
├── content (JSON)
└── metadata (JSON)
```

### Why This Structure?

**Step types are enums, not strings.** If developers could use arbitrary strings like "filter", "Filter", "filtering", "price-filter", cross-pipeline queries would be impossible. With enums, this works:

```sql
SELECT * FROM steps WHERE step_type = 'FILTER' AND drop_ratio > 0.9;
```

**Alternatives I considered:**

| Approach | Why Rejected |
|----------|--------------|
| Free-form JSON events | Can't query across pipelines |
| Span-based tracing | Optimized for latency, not decisions |
| Append-only log | No structured queries |

**What breaks with different choices:**
- Free-form step names → no cross-pipeline queries
- No capture levels → storage explodes or you lose detail
- Candidates not first-class → can't track what survived each step

## API Spec

### Ingest

**POST /api/v1/runs**
```json
{
  "run_id": "uuid",
  "pipeline_name": "competitor-selection",
  "pipeline_version": "v1.0.0",
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
  "candidates_in": 500,
  "candidates_out": 50,
  "drop_ratio": 0.9,
  "capture_level": "SUMMARY",
  "metrics": { "rejected_count": 450 },
  "artifacts": { "rule": "price < 100" }
}
```

**POST /api/v1/candidates** (batch, only for FULL capture)
```json
{
  "step_id": "uuid",
  "candidates": [
    { "candidate_id": "prod-123", "content": {...}, "metadata": {...} }
  ]
}
```

### Query

**GET /api/v1/runs?pipeline_name=X&step_type=FILTER&min_drop_ratio=0.9**

Returns runs that have filter steps with >90% drop ratio.

**GET /api/v1/runs/:id**

Returns run with all steps.

**GET /api/v1/analytics/high-drop-steps?step_type=FILTER&min_drop_ratio=0.9**

Returns steps across all pipelines matching criteria.

## Debugging Walkthrough

Scenario: Competitor selection returns a laptop stand for a phone case.

**Step 1: Find the run**
```
GET /api/v1/runs?pipeline_name=competitor-selection
```

**Step 2: Get all steps**
```
GET /api/v1/runs/<run_id>
```

**Step 3: Analyze each step**

```
GENERATION - keyword-extraction
  artifacts: { keywords: ["phone", "slim", "case", "matte"] }
  ⚠️ "phone" extracted as standalone keyword

RETRIEVAL - candidate-retrieval  
  candidates_out: 9
  ⚠️ Retrieved laptop stands that have "phone holder" feature

FILTER - price-rating-filter
  candidates_in: 9, candidates_out: 9, drop_ratio: 0
  ✓ Filter passed everything (not the problem)

RANKING - relevance-ranking
  artifacts: { 
    weights: { keyword_match: 0.35, reviews: 0.4, category: 0.05 },
    top_scores: [
      { id: "L002", score: 0.68, category: "laptop-accessories" },
      { id: "P005", score: 0.65, category: "phone-accessories" }
    ]
  }
  ⚠️ Category weight is 5%, reviews weight is 40%
  ⚠️ Laptop stand has more reviews, wins despite wrong category

SELECTION - best-match
  selected: "L002" (Portable Phone & Tablet Stand)
```

**Root cause:** Ranking weights category at 5% instead of 30%+. Laptop stands have more reviews, so they win.

**Fix:** Increase category weight in ranking algorithm.

## Queryability

The key constraint: **step_type must be an enum**.

This enables queries like:
- "Show all FILTER steps with >90% drop ratio" — across all pipelines
- "Show all RANKING steps where top_score < 0.5" — find low-confidence rankings
- "Show all GENERATION steps for pipeline X" — debug keyword extraction

Developers must use the enum values. The SDK enforces this at compile time (TypeScript).

For metrics and artifacts, we use JSON with conventions. Developers should use consistent keys within their pipeline. The GIN index on metrics enables queries like:

```sql
SELECT * FROM steps WHERE metrics->>'rejected_count' > 100;
```

## Performance & Scale

Scenario: 5,000 candidates filtered to 30.

| Capture Level | Storage | Use Case |
|---------------|---------|----------|
| NONE | ~100 bytes | Production, zero overhead |
| SUMMARY | ~1 KB | Debugging, metrics only |
| FULL | ~250 MB | Deep debugging, all candidates |

**Who decides?** The developer, per step:

```typescript
// Production: minimal overhead
await xray.step(StepType.FILTER, 'price-filter', filterFn);

// Debugging: capture artifacts
await xray.step(StepType.FILTER, 'price-filter', filterFn, {
  captureLevel: CaptureLevel.SUMMARY,
  artifacts: { rule: 'price < 100' }
});

// Deep debugging: capture all candidates
await xray.step(StepType.RANKING, 'relevance', rankFn, {
  captureLevel: CaptureLevel.FULL,
  candidates: candidates.map(c => ({ candidateId: c.id, content: c }))
});
```

**Trade-offs:**
- FULL capture is expensive → use selectively, sample top N candidates
- Async ingestion adds latency → but SDK never blocks pipeline
- Schema rigidity limits flexibility → but enables cross-pipeline queries

## Developer Experience

### (a) Minimal instrumentation

```typescript
import { xray, StepType } from '@xray/core';

xray.configure({ apiUrl: 'http://localhost:4000' });

await xray.run('my-pipeline', 'v1', async () => {
  const data = await xray.step(StepType.INPUT, 'fetch', fetchData);
  const filtered = await xray.step(StepType.FILTER, 'filter', () => filter(data));
  return await xray.step(StepType.SELECTION, 'select', () => pick(filtered));
});
```

You get: run tracking, step sequence, candidate counts, drop ratios.

### (b) Full instrumentation

```typescript
await xray.step(StepType.FILTER, 'price-filter', async () => {
  return candidates.filter(c => c.price < 100);
}, {
  captureLevel: CaptureLevel.FULL,
  candidates: candidates.map(c => ({ candidateId: c.id, content: c })),
  artifacts: { threshold: 100, rule: 'price < 100' },
  metrics: { rejected_count: 450, passed_count: 50 }
});
```

### (c) Backend unavailable

1. SDK logs a warning once
2. All subsequent xray.step() calls become no-ops
3. Pipeline continues normally
4. No exceptions thrown

The pipeline never breaks because of X-Ray.

## Real-World Application

I built a real-time sign language translator (hands2words) that had a multi-step ML inference pipeline:

1. **Frame extraction** — capture hand region from video feed
2. **Pose estimation** — detect hand landmarks using MediaPipe
3. **Feature extraction** — normalize landmarks, compute angles between joints
4. **Classification** — run through trained model to predict sign
5. **Post-processing** — apply confidence threshold, smooth predictions over time

When the system mistranslated signs, debugging was guesswork:

- Was the hand detection failing? 
- Were the landmarks noisy?
- Was the model confident but wrong?
- Was the smoothing filter dropping valid predictions?

Logs just showed "predicted: hello" with no visibility into intermediate steps.

With X-Ray, I would:
1. Wrap each stage with xray.step()
2. Capture artifacts: detected landmarks, confidence scores, raw vs smoothed predictions
3. Query: "Show runs where classification confidence > 0.8 but final output was wrong"
4. Find the pattern: pose estimation was jittery for certain hand positions, causing misclassification

The fix would be obvious: add temporal smoothing to landmarks before classification, not after.

Time to root cause: hours of staring at video frames → 5 minutes querying X-Ray.

## What Next?

If shipping this for production:

**Cost control**
- Adaptive sampling: reduce capture level under high load
- Storage quotas per pipeline
- Auto-downgrade to SUMMARY when quota exceeded

**Privacy**
- PII redaction rules before storage
- Configurable retention policies
- Audit logging for queries

**Query performance**
- Materialized views for common aggregations
- Time-based partitioning
- Query caching

**Developer experience**
- CLI tool: `xray query --pipeline=X --step-type=FILTER --min-drop=0.9`
- IDE integration
- Alerting on anomalous drop ratios

**Visualization**
- Decision flow diagrams
- Side-by-side run comparison
- Anomaly highlighting

## Trade-offs

| Decision | Sacrifice | Gain |
|----------|-----------|------|
| Enum step types | Flexibility | Cross-pipeline queries |
| Schema rigidity | Arbitrary fields | Structured queries |
| FULL capture cost | Storage | Deep debugging |
| Async ingestion | Real-time | Non-blocking SDK |

## Out of Scope

- UI dashboards
- Authentication
- Real-time streaming
- Distributed tracing
- Model monitoring

These are acknowledged, not forgotten.
