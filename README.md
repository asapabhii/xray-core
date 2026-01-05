# X-Ray

When your ML pipeline returns garbage, logs tell you what happened. X-Ray tells you why.

This is a decision observability SDK. You wrap your pipeline steps, it captures the decision context; what candidates came in, what got filtered, what scored highest, and why. When something breaks, you query the data instead of adding print statements.

## Setup

```bash
npm install
npm run build
```

## Quick Demo

```bash
npm run server   # Terminal 1 - starts reference backend
npm run demo     # Terminal 2 - runs example pipeline
```

Query the results:
```bash
curl http://localhost:4000/api/v1/runs
```

Example response:
```json
{
  "runs": [
    {
      "run_id": "550e8400-e29b-41d4-a716-446655440000",
      "pipeline_name": "competitor-selection",
      "pipeline_version": "v1.0.0",
      "environment": "prod",
      "started_at": "2024-01-15T10:00:00.000Z",
      "ended_at": "2024-01-15T10:00:05.000Z"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

Get run details with all steps:
```bash
curl http://localhost:4000/api/v1/runs/<run_id>
```

Example response:
```json
{
  "run": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000",
    "pipeline_name": "competitor-selection",
    "pipeline_version": "v1.0.0"
  },
  "steps": [
    {
      "step_type": "FILTER",
      "step_name": "price-filter",
      "candidates_in": 500,
      "candidates_out": 50,
      "drop_ratio": 0.9,
      "artifacts": { "rule": "price < 100" }
    }
  ]
}
```

Find high drop ratio steps across all pipelines:
```bash
curl "http://localhost:4000/api/v1/analytics/high-drop-steps?min_drop_ratio=0.8"
```

## Usage

```typescript
import { xray, StepType, CaptureLevel } from '@xray/core';

xray.configure({ apiUrl: 'http://localhost:4000' });

await xray.run('my-pipeline', 'v1', async () => {
  const data = await xray.step(StepType.INPUT, 'fetch', fetchData);
  
  const filtered = await xray.step(StepType.FILTER, 'filter', () => filter(data), {
    captureLevel: CaptureLevel.SUMMARY,
    artifacts: { rule: 'price < 100' }
  });
  
  return await xray.step(StepType.SELECTION, 'select', () => pick(filtered));
});
```

Backend goes down? SDK becomes a no-op. Your pipeline keeps running.

## Why step types are enums

Cross-pipeline queries. If developers could write "filter", "Filter", "filtering", "price-filter" — you'd never be able to ask "show me all filter steps that dropped >90% of candidates" across your entire system.

With enums, that query just works.

## Capture levels

| Level | What you get | Cost |
|-------|--------------|------|
| NONE | Step metadata | ~100 bytes |
| SUMMARY | + metrics, artifacts | ~1 KB |
| FULL | + all candidates | ~50KB × candidates |

Developer decides per step. Default is NONE.

## Limitations

- No UI
- No auth
- Demo backend uses SQLite; production would use PostgreSQL (schema in `backend/schema.sql`)
- FULL capture is expensive — use it selectively

## Publishing

Not published to npm yet. Structured to be publishable when ready.

```bash
npm install @xray/core
```

## What's next

- Adaptive sampling under load
- PII redaction
- CLI for queries
- Alerting on anomalous patterns

## Structure

```
src/           SDK source
server/        Demo backend (SQLite)
examples/      Demo pipelines
backend/       API spec + PostgreSQL schema
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design rationale.

## License

MIT
