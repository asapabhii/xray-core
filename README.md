# X-Ray

When your ML pipeline returns garbage, logs tell you what happened. X-Ray tells you why.

This is a decision observability SDK. You wrap your pipeline steps, it captures the decision context; what candidates came in, what got filtered, what scored highest, and why. When something breaks, you query the data instead of adding print statements.

## Setup

```bash
npm install
npm run build
```

## Run

```bash
npm run server   # Terminal 1
npm run demo     # Terminal 2
```

Query the results:
```bash
curl http://localhost:4000/api/v1/runs
curl http://localhost:4000/api/v1/runs/<run_id>
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
- Reference backend uses SQLite (prod would be Postgres)
- FULL capture is expensive — use it selectively

## What's next

- Adaptive sampling under load
- PII redaction
- CLI for queries
- Alerting on anomalous patterns

## Structure

```
src/           SDK
server/        Reference backend
examples/      Demo pipelines
backend/       API spec + Postgres schema
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design rationale.

## License

MIT
