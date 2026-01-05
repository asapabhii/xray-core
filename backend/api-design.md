# Backend API Design

## Overview

RESTful API for ingesting and querying X-Ray data. Designed for queryability over flexibility.

## Base URL

```
http://localhost:4000/api/v1
```

## Authentication

Not implemented. In production, use API keys or mTLS.
## Ingest Endpoints

### POST /runs

Create or update a run.

**Request:**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "pipeline_name": "competitor-selection",
  "pipeline_version": "v2.1.0",
  "environment": "prod",
  "started_at": "2024-01-15T10:00:00Z",
  "ended_at": "2024-01-15T10:05:00Z",
  "metadata": {
    "user_id": "user-123",
    "request_id": "req-456"
  }
}
```

**Response:**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "created"
}
```

**Status Codes:**
- `201 Created`: Run created successfully
- `200 OK`: Run updated (if ended_at provided)
- `400 Bad Request`: Invalid request body

### POST /steps

Create a step within a run.

**Request:**
```json
{
  "step_id": "660e8400-e29b-41d4-a716-446655440001",
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "step_type": "FILTER",
  "step_name": "price-filter",
  "position": 2,
  "metrics": {
    "rejection_reason": "price_too_high",
    "threshold": 100
  },
  "candidates_in": 500,
  "candidates_out": 50,
  "drop_ratio": 0.9,
  "capture_level": "SUMMARY",
  "artifacts": {
    "rule": "price < 100",
    "rejected_count": 450
  },
  "started_at": "2024-01-15T10:00:05Z",
  "ended_at": "2024-01-15T10:00:06Z"
}
```

**Response:**
```json
{
  "step_id": "660e8400-e29b-41d4-a716-446655440001",
  "status": "created"
}
```

**Status Codes:**
- `201 Created`: Step created successfully
- `400 Bad Request`: Invalid step_type or request body
- `404 Not Found`: Run not found

**Validation:**
- `step_type` must be one of: INPUT, GENERATION, RETRIEVAL, FILTER, RANKING, EVALUATION, SELECTION
- `capture_level` must be one of: NONE, SUMMARY, FULL
- `drop_ratio` must be between 0 and 1
- `position` must be unique within a run

### POST /candidates

Batch ingest candidates for a step (only if `capture_level = FULL`).

**Request:**
```json
{
  "step_id": "660e8400-e29b-41d4-a716-446655440001",
  "candidates": [
    {
      "candidate_id": "prod-123",
      "content": {
        "id": "prod-123",
        "name": "Phone Case",
        "price": 29.99
      },
      "metadata": {
        "score": 0.95,
        "category": "electronics"
      }
    },
    {
      "candidate_id": "prod-456",
      "content": {
        "id": "prod-456",
        "name": "Laptop Stand",
        "price": 49.99
      },
      "metadata": {
        "score": 0.82,
        "category": "accessories"
      }
    }
  ]
}
```

**Response:**
```json
{
  "step_id": "660e8400-e29b-41d4-a716-446655440001",
  "candidates_ingested": 2,
  "status": "created"
}
```

**Status Codes:**
- `201 Created`: Candidates ingested successfully
- `400 Bad Request`: Step capture_level is not FULL
- `404 Not Found`: Step not found

**Limits:**
- Maximum 1000 candidates per request
- Use pagination for larger batches

## Query Endpoints

### GET /runs/:run_id

Get a run with all its steps.

**Response:**
```json
{
  "run": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000",
    "pipeline_name": "competitor-selection",
    "pipeline_version": "v2.1.0",
    "environment": "prod",
    "started_at": "2024-01-15T10:00:00Z",
    "ended_at": "2024-01-15T10:05:00Z",
    "metadata": {}
  },
  "steps": [
    {
      "step_id": "660e8400-e29b-41d4-a716-446655440001",
      "step_type": "INPUT",
      "step_name": "fetch-products",
      "position": 0,
      "candidates_in": 0,
      "candidates_out": 5000,
      "drop_ratio": 0,
      "capture_level": "NONE"
    }
  ]
}
```

**Status Codes:**
- `200 OK`: Run found
- `404 Not Found`: Run not found

### GET /runs

Filter runs by criteria.

**Query Parameters:**
- `pipeline_name` (string): Filter by pipeline name
- `pipeline_version` (string): Filter by version
- `environment` (string): Filter by environment (dev/staging/prod)
- `started_after` (ISO 8601): Filter runs started after this time
- `started_before` (ISO 8601): Filter runs started before this time
- `step_type` (string): Filter runs that have steps of this type
- `min_drop_ratio` (float): Filter runs with steps having drop_ratio >= this value
- `limit` (integer, default: 100): Maximum number of results
- `offset` (integer, default: 0): Pagination offset

**Example:**
```
GET /runs?pipeline_name=competitor-selection&step_type=FILTER&min_drop_ratio=0.9&limit=50
```

**Response:**
```json
{
  "runs": [
    {
      "run_id": "550e8400-e29b-41d4-a716-446655440000",
      "pipeline_name": "competitor-selection",
      "pipeline_version": "v2.1.0",
      "environment": "prod",
      "started_at": "2024-01-15T10:00:00Z",
      "ended_at": "2024-01-15T10:05:00Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

**Status Codes:**
- `200 OK`: Query successful
- `400 Bad Request`: Invalid query parameters

### GET /steps

Get steps, optionally filtered.

**Query Parameters:**
- `run_id` (UUID): Get all steps for a run
- `step_type` (string): Filter by step type
- `step_name` (string): Filter by step name
- `min_drop_ratio` (float): Filter steps with drop_ratio >= this value
- `limit` (integer, default: 100): Maximum number of results
- `offset` (integer, default: 0): Pagination offset

**Example:**
```
GET /steps?run_id=550e8400-e29b-41d4-a716-446655440000
```

**Response:**
```json
{
  "steps": [
    {
      "step_id": "660e8400-e29b-41d4-a716-446655440001",
      "run_id": "550e8400-e29b-41d4-a716-446655440000",
      "step_type": "FILTER",
      "step_name": "price-filter",
      "position": 2,
      "metrics": {
        "rejection_reason": "price_too_high"
      },
      "candidates_in": 500,
      "candidates_out": 50,
      "drop_ratio": 0.9,
      "capture_level": "SUMMARY",
      "artifacts": {
        "rule": "price < 100"
      },
      "started_at": "2024-01-15T10:00:05Z",
      "ended_at": "2024-01-15T10:00:06Z"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

**Status Codes:**
- `200 OK`: Query successful
- `400 Bad Request`: Invalid query parameters

### GET /steps/:step_id/candidates

Get candidates for a step (only if `capture_level = FULL`).

**Response:**
```json
{
  "step_id": "660e8400-e29b-41d4-a716-446655440001",
  "candidates": [
    {
      "candidate_id": "prod-123",
      "content": {
        "id": "prod-123",
        "name": "Phone Case",
        "price": 29.99
      },
      "metadata": {
        "score": 0.95
      }
    }
  ],
  "total": 1
}
```

**Status Codes:**
- `200 OK`: Candidates found
- `404 Not Found`: Step not found or capture_level is not FULL

## Analytics Endpoints

### GET /analytics/high-drop-steps

Find steps with high drop ratios across all pipelines. Useful for identifying bottlenecks and debugging aggressive filters.

**Query Parameters:**
- `min_drop_ratio` (float, default: 0.9): Minimum drop ratio threshold
- `step_type` (string): Filter by step type
- `limit` (integer, default: 50): Maximum number of results

**Example:**
```
GET /analytics/high-drop-steps?min_drop_ratio=0.8&step_type=FILTER&limit=20
```

**Response:**
```json
{
  "steps": [
    {
      "step_id": "660e8400-e29b-41d4-a716-446655440001",
      "run_id": "550e8400-e29b-41d4-a716-446655440000",
      "step_type": "FILTER",
      "step_name": "price-filter",
      "position": 2,
      "metrics": {
        "rejection_reason": "price_too_high"
      },
      "candidates_in": 500,
      "candidates_out": 50,
      "drop_ratio": 0.9,
      "capture_level": "SUMMARY",
      "artifacts": {
        "rule": "price < 100"
      },
      "started_at": "2024-01-15T10:00:05Z",
      "ended_at": "2024-01-15T10:00:06Z",
      "pipeline_name": "competitor-selection",
      "pipeline_version": "v2.1.0",
      "run_started_at": "2024-01-15T10:00:00Z"
    }
  ]
}
```

**Status Codes:**
- `200 OK`: Query successful
- `400 Bad Request`: Invalid query parameters

## Utility Endpoints

### GET /

Returns API metadata and available endpoints. Useful for discovery.

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:00:00Z"
}
```

## Indexing Strategy

### Primary Indexes
- `runs(run_id)`: Primary key
- `steps(step_id)`: Primary key
- `steps(run_id, position)`: For ordered step retrieval
- `candidates(step_id, candidate_id)`: Composite primary key

### Secondary Indexes
- `runs(pipeline_name, pipeline_version)`: For pipeline filtering
- `runs(environment, started_at)`: For time-based queries
- `steps(step_type, drop_ratio)`: For cross-pipeline queries
- `steps(step_name)`: For step name filtering
- GIN index on `steps.metrics`: For JSONB key-value queries
- GIN index on `steps.artifacts`: For artifact queries

### Query Optimization
- Use covering indexes where possible
- Partition `runs` and `steps` by `started_at` (monthly) for retention
- Materialized views for common aggregations (optional)

## Storage Assumptions

- **PostgreSQL 14+**: For structured queries and JSONB support
- **Optional object storage**: For large candidate blobs if FULL capture exceeds row size limits

## Rate Limiting

Not implemented. Production would use:
- **Ingest**: 1000 requests/minute per client
- **Query**: 100 requests/minute per client

## Error Responses

All errors follow this format:
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": { }
  }
}
```

| Code | HTTP | Description |
|------|------|-------------|
| `INVALID_REQUEST` | 400 | Missing required fields |
| `INVALID_STEP_TYPE` | 400 | step_type not in enum |
| `INVALID_CAPTURE_LEVEL` | 400 | capture_level not in enum |
| `RUN_NOT_FOUND` | 404 | Referenced run does not exist |
| `STEP_NOT_FOUND` | 404 | Referenced step does not exist |
| `CANDIDATES_NOT_CAPTURED` | 400/404 | Step capture_level is not FULL |
| `INTERNAL_ERROR` | 500 | Server error |

