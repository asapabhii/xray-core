/**
 * X-Ray Backend Server
 * 
 * SQLite-based backend for local development and demos.
 * For production, use PostgreSQL with the schema in backend/schema.sql.
 */

import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Initialize SQLite database
const db = new Database('xray.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    pipeline_name TEXT NOT NULL,
    pipeline_version TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'prod',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_runs_pipeline ON runs(pipeline_name, pipeline_version);
  CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

  CREATE TABLE IF NOT EXISTS steps (
    step_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_type TEXT NOT NULL,
    step_name TEXT NOT NULL,
    position INTEGER NOT NULL,
    metrics TEXT NOT NULL DEFAULT '{}',
    candidates_in INTEGER NOT NULL,
    candidates_out INTEGER NOT NULL,
    drop_ratio REAL,
    capture_level TEXT NOT NULL,
    artifacts TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, position);
  CREATE INDEX IF NOT EXISTS idx_steps_type ON steps(step_type);
  CREATE INDEX IF NOT EXISTS idx_steps_drop ON steps(drop_ratio);

  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    content TEXT,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_candidates_step ON candidates(step_id);
`);

// ============ INGEST ENDPOINTS ============

// POST /api/v1/runs - Create or update a run
app.post('/api/v1/runs', (req, res) => {
  try {
    const { run_id, pipeline_name, pipeline_version, environment, started_at, ended_at, metadata } = req.body;

    if (!run_id || !pipeline_name || !pipeline_version || !started_at) {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Missing required fields' } });
    }

    const existing = db.prepare('SELECT run_id FROM runs WHERE run_id = ?').get(run_id);

    if (existing) {
      // Update existing run
      db.prepare(`
        UPDATE runs SET ended_at = ?, metadata = ? WHERE run_id = ?
      `).run(ended_at || null, metadata ? JSON.stringify(metadata) : null, run_id);
      return res.json({ run_id, status: 'updated' });
    }

    // Create new run
    db.prepare(`
      INSERT INTO runs (run_id, pipeline_name, pipeline_version, environment, started_at, ended_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(run_id, pipeline_name, pipeline_version, environment || 'prod', started_at, ended_at || null, metadata ? JSON.stringify(metadata) : null);

    res.status(201).json({ run_id, status: 'created' });
  } catch (error: any) {
    console.error('Error creating run:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// POST /api/v1/steps - Create a step
app.post('/api/v1/steps', (req, res) => {
  try {
    const { step_id, run_id, step_type, step_name, position, metrics, candidates_in, candidates_out, drop_ratio, capture_level, artifacts, started_at, ended_at } = req.body;

    const validStepTypes = ['INPUT', 'GENERATION', 'RETRIEVAL', 'FILTER', 'RANKING', 'EVALUATION', 'SELECTION'];
    const validCaptureLevels = ['NONE', 'SUMMARY', 'FULL'];

    if (!validStepTypes.includes(step_type)) {
      return res.status(400).json({
        error: { code: 'INVALID_STEP_TYPE', message: `step_type must be one of: ${validStepTypes.join(', ')}`, details: { provided: step_type, allowed: validStepTypes } }
      });
    }

    if (!validCaptureLevels.includes(capture_level)) {
      return res.status(400).json({
        error: { code: 'INVALID_CAPTURE_LEVEL', message: `capture_level must be one of: ${validCaptureLevels.join(', ')}` }
      });
    }

    const run = db.prepare('SELECT run_id FROM runs WHERE run_id = ?').get(run_id);
    if (!run) {
      return res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: 'Referenced run does not exist' } });
    }

    db.prepare(`
      INSERT INTO steps (step_id, run_id, step_type, step_name, position, metrics, candidates_in, candidates_out, drop_ratio, capture_level, artifacts, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(step_id, run_id, step_type, step_name, position, JSON.stringify(metrics || {}), candidates_in, candidates_out, drop_ratio, capture_level, artifacts ? JSON.stringify(artifacts) : null, started_at, ended_at || null);

    res.status(201).json({ step_id, status: 'created' });
  } catch (error: any) {
    console.error('Error creating step:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});


// POST /api/v1/candidates - Batch ingest candidates
app.post('/api/v1/candidates', (req, res) => {
  try {
    const { step_id, candidates } = req.body;

    const step = db.prepare('SELECT step_id, capture_level FROM steps WHERE step_id = ?').get(step_id) as any;
    if (!step) {
      return res.status(404).json({ error: { code: 'STEP_NOT_FOUND', message: 'Referenced step does not exist' } });
    }

    if (step.capture_level !== 'FULL') {
      return res.status(400).json({ error: { code: 'CANDIDATES_NOT_CAPTURED', message: 'Step capture_level is not FULL' } });
    }

    const insert = db.prepare(`
      INSERT INTO candidates (candidate_id, step_id, content, metadata)
      VALUES (?, ?, ?, ?)
    `);

    const insertMany = db.transaction((candidates: any[]) => {
      for (const c of candidates) {
        insert.run(c.candidate_id, step_id, c.content ? JSON.stringify(c.content) : null, c.metadata ? JSON.stringify(c.metadata) : null);
      }
    });

    insertMany(candidates || []);

    res.status(201).json({ step_id, candidates_ingested: candidates?.length || 0, status: 'created' });
  } catch (error: any) {
    console.error('Error creating candidates:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// ============ QUERY ENDPOINTS ============

// GET /api/v1/runs/:run_id - Get a run with all steps
app.get('/api/v1/runs/:run_id', (req, res) => {
  try {
    const { run_id } = req.params;

    const run = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(run_id) as any;
    if (!run) {
      return res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: 'Run not found' } });
    }

    const steps = db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY position').all(run_id) as any[];

    res.json({
      run: {
        ...run,
        metadata: run.metadata ? JSON.parse(run.metadata) : null
      },
      steps: steps.map(s => ({
        ...s,
        metrics: JSON.parse(s.metrics),
        artifacts: s.artifacts ? JSON.parse(s.artifacts) : null
      }))
    });
  } catch (error: any) {
    console.error('Error fetching run:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// GET /api/v1/runs - Filter runs
app.get('/api/v1/runs', (req, res) => {
  try {
    const { pipeline_name, pipeline_version, environment, started_after, started_before, step_type, min_drop_ratio, limit = '100', offset = '0' } = req.query;

    let query = 'SELECT DISTINCT r.* FROM runs r';
    const params: any[] = [];
    const conditions: string[] = [];

    // Join with steps if filtering by step criteria
    if (step_type || min_drop_ratio) {
      query += ' JOIN steps s ON r.run_id = s.run_id';
      if (step_type) {
        conditions.push('s.step_type = ?');
        params.push(step_type);
      }
      if (min_drop_ratio) {
        conditions.push('s.drop_ratio >= ?');
        params.push(parseFloat(min_drop_ratio as string));
      }
    }

    if (pipeline_name) {
      conditions.push('r.pipeline_name = ?');
      params.push(pipeline_name);
    }
    if (pipeline_version) {
      conditions.push('r.pipeline_version = ?');
      params.push(pipeline_version);
    }
    if (environment) {
      conditions.push('r.environment = ?');
      params.push(environment);
    }
    if (started_after) {
      conditions.push('r.started_at >= ?');
      params.push(started_after);
    }
    if (started_before) {
      conditions.push('r.started_at <= ?');
      params.push(started_before);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY r.started_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit as string), parseInt(offset as string));

    const runs = db.prepare(query).all(...params) as any[];

    // Get total count
    let countQuery = 'SELECT COUNT(DISTINCT r.run_id) as total FROM runs r';
    if (step_type || min_drop_ratio) {
      countQuery += ' JOIN steps s ON r.run_id = s.run_id';
    }
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countParams = params.slice(0, -2); // Remove limit and offset
    const { total } = db.prepare(countQuery).get(...countParams) as any;

    res.json({
      runs: runs.map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null })),
      total,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string)
    });
  } catch (error: any) {
    console.error('Error fetching runs:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// GET /api/v1/steps - Get steps with filters
app.get('/api/v1/steps', (req, res) => {
  try {
    const { run_id, step_type, step_name, min_drop_ratio, limit = '100', offset = '0' } = req.query;

    let query = 'SELECT * FROM steps';
    const params: any[] = [];
    const conditions: string[] = [];

    if (run_id) {
      conditions.push('run_id = ?');
      params.push(run_id);
    }
    if (step_type) {
      conditions.push('step_type = ?');
      params.push(step_type);
    }
    if (step_name) {
      conditions.push('step_name = ?');
      params.push(step_name);
    }
    if (min_drop_ratio) {
      conditions.push('drop_ratio >= ?');
      params.push(parseFloat(min_drop_ratio as string));
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY run_id, position LIMIT ? OFFSET ?';
    params.push(parseInt(limit as string), parseInt(offset as string));

    const steps = db.prepare(query).all(...params) as any[];

    res.json({
      steps: steps.map(s => ({
        ...s,
        metrics: JSON.parse(s.metrics),
        artifacts: s.artifacts ? JSON.parse(s.artifacts) : null
      })),
      total: steps.length,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string)
    });
  } catch (error: any) {
    console.error('Error fetching steps:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// GET /api/v1/steps/:step_id/candidates - Get candidates for a step
app.get('/api/v1/steps/:step_id/candidates', (req, res) => {
  try {
    const { step_id } = req.params;

    const step = db.prepare('SELECT step_id, capture_level FROM steps WHERE step_id = ?').get(step_id) as any;
    if (!step) {
      return res.status(404).json({ error: { code: 'STEP_NOT_FOUND', message: 'Step not found' } });
    }

    if (step.capture_level !== 'FULL') {
      return res.status(404).json({ error: { code: 'CANDIDATES_NOT_CAPTURED', message: 'Step capture_level is not FULL' } });
    }

    const candidates = db.prepare('SELECT candidate_id, content, metadata FROM candidates WHERE step_id = ?').all(step_id) as any[];

    res.json({
      step_id,
      candidates: candidates.map(c => ({
        candidate_id: c.candidate_id,
        content: c.content ? JSON.parse(c.content) : null,
        metadata: c.metadata ? JSON.parse(c.metadata) : null
      })),
      total: candidates.length
    });
  } catch (error: any) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// ============ ANALYTICS ENDPOINTS ============

// GET /api/v1/analytics/high-drop-steps - Find steps with high drop ratios across all pipelines
app.get('/api/v1/analytics/high-drop-steps', (req, res) => {
  try {
    const { min_drop_ratio = '0.9', step_type, limit = '50' } = req.query;

    let query = `
      SELECT s.*, r.pipeline_name, r.pipeline_version, r.started_at as run_started_at
      FROM steps s
      JOIN runs r ON s.run_id = r.run_id
      WHERE s.drop_ratio >= ?
    `;
    const params: any[] = [parseFloat(min_drop_ratio as string)];

    if (step_type) {
      query += ' AND s.step_type = ?';
      params.push(step_type);
    }

    query += ' ORDER BY s.drop_ratio DESC LIMIT ?';
    params.push(parseInt(limit as string));

    const steps = db.prepare(query).all(...params) as any[];

    res.json({
      steps: steps.map(s => ({
        ...s,
        metrics: JSON.parse(s.metrics),
        artifacts: s.artifacts ? JSON.parse(s.artifacts) : null
      }))
    });
  } catch (error: any) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  }
});

// Root route - API info
app.get('/', (req, res) => {
  res.json({
    name: 'X-Ray Decision Observability API',
    version: '1.0.0',
    endpoints: {
      ingest: {
        'POST /api/v1/runs': 'Create or update a run',
        'POST /api/v1/steps': 'Create a step',
        'POST /api/v1/candidates': 'Batch ingest candidates'
      },
      query: {
        'GET /api/v1/runs': 'List/filter runs',
        'GET /api/v1/runs/:id': 'Get run with all steps',
        'GET /api/v1/steps': 'Query steps',
        'GET /api/v1/steps/:id/candidates': 'Get candidates for a step',
        'GET /api/v1/analytics/high-drop-steps': 'Find high drop ratio steps'
      },
      health: {
        'GET /health': 'Health check'
      }
    },
    docs: 'See ARCHITECTURE.md for full documentation'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`X-Ray server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
