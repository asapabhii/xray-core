-- X-Ray Database Schema
-- PostgreSQL 14+
-- 
-- Note: Reference server uses SQLite for portability.
-- This schema is the production-ready PostgreSQL version.

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
CREATE INDEX idx_runs_started_at ON runs(started_at DESC);

-- Steps table
CREATE TABLE steps (
  step_id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_type VARCHAR(50) NOT NULL,
  step_name VARCHAR(255) NOT NULL,
  position INTEGER NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}',
  candidates_in INTEGER NOT NULL,
  candidates_out INTEGER NOT NULL,
  -- drop_ratio is nullable for INPUT steps where candidates_in = 0
  -- Edge case: if candidates_in = 0, drop_ratio is undefined (NULL)
  drop_ratio DECIMAL(5,4),
  capture_level VARCHAR(20) NOT NULL,
  artifacts JSONB,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  CONSTRAINT valid_step_type CHECK (step_type IN ('INPUT', 'GENERATION', 'RETRIEVAL', 'FILTER', 'RANKING', 'EVALUATION', 'SELECTION')),
  CONSTRAINT valid_capture_level CHECK (capture_level IN ('NONE', 'SUMMARY', 'FULL')),
  CONSTRAINT valid_drop_ratio CHECK (drop_ratio IS NULL OR (drop_ratio >= 0 AND drop_ratio <= 1)),
  CONSTRAINT unique_position_per_run UNIQUE (run_id, position)
);

CREATE INDEX idx_steps_run ON steps(run_id, position);
CREATE INDEX idx_steps_type ON steps(step_type, drop_ratio);
CREATE INDEX idx_steps_name ON steps(step_name);
CREATE INDEX idx_steps_metrics ON steps USING GIN(metrics);
CREATE INDEX idx_steps_artifacts ON steps USING GIN(artifacts);

-- Candidates table (only populated if capture_level = FULL)
CREATE TABLE candidates (
  candidate_id VARCHAR(255) NOT NULL,
  step_id UUID NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  content JSONB,
  metadata JSONB,
  PRIMARY KEY (candidate_id, step_id)
);

CREATE INDEX idx_candidates_step ON candidates(step_id);
CREATE INDEX idx_candidates_metadata ON candidates USING GIN(metadata);

-- Partitioning for retention (optional, for high-volume deployments)
-- CREATE TABLE steps_2024_01 PARTITION OF steps
--   FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Example queries:
-- 
-- Find runs with high drop ratios in filter steps:
-- SELECT DISTINCT r.run_id, r.pipeline_name, s.step_name, s.drop_ratio
-- FROM runs r
-- JOIN steps s ON r.run_id = s.run_id
-- WHERE s.step_type = 'FILTER' AND s.drop_ratio > 0.9;
--
-- Find ranking steps with score variance:
-- SELECT step_id, step_name, metrics->>'score_variance' as variance
-- FROM steps
-- WHERE step_type = 'RANKING' 
--   AND (metrics->>'score_variance')::float > 0.5;

