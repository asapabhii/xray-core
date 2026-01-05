# X-Ray: Decision Observability for Algorithmic Pipelines

X-Ray is a reference SDK and system design prototype built for demonstrating decision observability in multi-step, non-deterministic algorithmic pipelines. It answers one question: **"Why did the system make this decision?"**

This is a reference implementation, not a production-ready system. Deployment, authentication, and operational concerns are intentionally out of scope.

## Intent

X-Ray is designed for engineers debugging complex pipelines that combine:
- LLMs (non-deterministic outputs)
- Heuristics (rule-based filtering)
- Ranking algorithms (score-based selection)
- Multi-step workflows (candidate generation → filtering → ranking → selection)

Unlike traditional observability tools that focus on execution (latency, errors, traces), X-Ray focuses on **decision observability**: understanding why the system made specific choices, not just how long it took.

## Core Principles

1. **Decision observability > execution observability**: Model why decisions were made, not execution time
2. **Queryability beats flexibility**: Rigid schemas enable cross-pipeline queries
3. **Defaults must be safe**: Minimal capture by default, opt-in for verbosity
4. **Instrumentation must never break the pipeline**: SDK degrades to no-op if backend is unavailable
5. **Boring tech + clear abstractions > cleverness**: PostgreSQL, REST APIs, no exotic tech
6. **Explicit trade-offs > pretending something is perfect**: Acknowledge limitations upfront

## Safe Defaults

The SDK is designed with safety as the default:
- **Default capture level is NONE**: Zero overhead until explicitly opted-in
- **SDK is non-blocking**: All instrumentation is fire-and-forget
- **SDK degrades to no-op on failure**: If the backend is unavailable, the pipeline continues normally without exceptions

## Quick Start

### Installation

```bash
npm install @xray/core
```

### Basic Usage

Start with minimal instrumentation (NONE capture level by default):

```typescript
import { xray, StepType, CaptureLevel } from '@xray/core';

const result = await xray.run('competitor-selection', 'v1.0.0', async () => {
  const candidates = await xray.step(StepType.INPUT, 'fetch-products', async () => {
    return await fetchProducts();
  });

  // Opt-in to SUMMARY capture for debugging
  const filtered = await xray.step(StepType.FILTER, 'price-filter', async () => {
    return candidates.filter(p => p.price < 100);
  }, {
    captureLevel: CaptureLevel.SUMMARY,
    artifacts: { threshold: 100, rule: 'price < 100' }
  });

  return filtered;
});
```

Step types and capture levels are strict enums to preserve cross-pipeline queryability.

### Configuration

The SDK is configured to send data to a local or internal X-Ray service:

```typescript
import { xray, CaptureLevel } from '@xray/core';

xray.configure({
  apiUrl: 'http://localhost:4000', // Local or internal service
  defaultCaptureLevel: CaptureLevel.NONE, // Safe default: zero overhead
  enableAsyncIngestion: true,
  degradeOnError: true // Degrade to no-op if backend unavailable
});
```

Advanced tuning options are available in `src/config.ts`. Configuration is global and affects all subsequent runs.

## Real-World Retrofit Example

### System: E-commerce Search Ranking Pipeline

**Context:**
A real-world search system with a multi-stage pipeline:
1. Query expansion (LLM-based)
2. Candidate retrieval (vector DB)
3. Filtering (price, availability, category)
4. Ranking (learned model)
5. Selection (top 10)

**Problem:**
Bad results (irrelevant products ranked high) with no explanation. Engineers spent hours debugging by:
- Adding print statements
- Manually inspecting logs
- Guessing which step failed

**Why logs failed:**
- Logs showed: "retrieved 1000 candidates, ranked, returned top 10"
- No visibility into:
  - Which filters eliminated good candidates
  - Why ranking model scored irrelevant items high
  - What the LLM expanded the query to

**X-Ray Solution:**

```typescript
// Before: Opaque pipeline
async function searchPipeline(query: string) {
  const expanded = await expandQuery(query);
  const candidates = await retrieve(expanded);
  const filtered = await filter(candidates);
  const ranked = await rank(filtered);
  return ranked.slice(0, 10);
}

// After: Instrumented with X-Ray
async function searchPipeline(query: string) {
  return await xray.run('search-pipeline', 'v2.1.0', async () => {
    const expanded = await xray.step(StepType.GENERATION, 'query-expansion', async () => {
      return await expandQuery(query);
    }, {
      captureLevel: CaptureLevel.SUMMARY,
      artifacts: { model: 'gpt-4', original_query: query }
    });

    const candidates = await xray.step(StepType.RETRIEVAL, 'vector-search', async () => {
      return await retrieve(expanded);
    });

    const filtered = await xray.step(StepType.FILTER, 'availability-filter', async () => {
      return await filter(candidates);
    }, {
      captureLevel: CaptureLevel.SUMMARY,
      artifacts: { rules: ['in_stock', 'price_range'] }
    });

    const ranked = await xray.step(StepType.RANKING, 'relevance-model', async () => {
      return await rank(filtered);
    }, {
      captureLevel: CaptureLevel.FULL,
      candidates: filtered.slice(0, 100).map(c => ({
        candidateId: c.id,
        content: c,
        metadata: { score: calculateScore(c) }
      })),
      artifacts: { model_version: 'v3', top_score: 0.95 }
    });

    return await xray.step(StepType.SELECTION, 'top-10', async () => {
      return ranked.slice(0, 10);
    });
  });
}
```

**Impact:**
- **Time to root cause**: 2 hours → 5 minutes
- **Query**: "Show all runs where FILTER steps dropped >80% and final selection had low relevance scores"
- **Finding**: Query expansion was adding irrelevant keywords, causing retrieval to fetch wrong category, but ranking still scored them high due to keyword overlap

**Retrofit approach:**
1. Wrap existing functions with `xray.step()` (minimal code changes)
2. Start with `CaptureLevel.NONE` (zero performance impact, default)
3. Gradually increase to `SUMMARY` for critical steps (opt-in)
4. Use `FULL` only for ranking step (most critical for debugging, advanced opt-in)

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed design, trade-offs, and data model.

## API Reference

See [backend/api-design.md](./backend/api-design.md) for complete API documentation.

## Examples

See [examples/debugging-walkthrough.ts](./examples/debugging-walkthrough.ts) for a concrete debugging scenario.

## What This System Is NOT

- **Not tracing**: We track decision boundaries, not execution spans
- **Not logging**: Structured decision artifacts, not free-form text
- **Not metrics**: Step-level metrics are normalized and queryable, not aggregated time-series
- **Not model monitoring**: We explain decisions, not model performance over time

## Limitations

1. **Schema rigidity**: Cannot add arbitrary fields without migration (trade-off for queryability)
2. **Capture overhead**: FULL capture is expensive (opt-in only, sampling strategies)
3. **No real-time guarantees**: Async ingestion means slight delay (trade-off for non-blocking SDK)
4. **Step typing enforcement**: Developers must use enum values (trade-off for cross-pipeline queries)
5. **Metric normalization**: Must use known keys (trade-off for structured queries)

## Out of Scope

- UI dashboards (acknowledged, not built)
- Real-time streaming guarantees
- Auth, billing, tenancy
- Model training or evaluation
- Distributed tracing / latency analysis

## License

MIT

