import { v4 as uuidv4 } from 'uuid';
import { Run, Step, Candidate, StepType, CaptureLevel, StepOptions, RunOptions, Environment } from './types';
import { XRayConfig, defaultConfig } from './config';

export class XRayClient {
  private config: XRayConfig;
  private currentRunId: string | null = null;
  private currentRun: Run | null = null;
  private stepPosition: number = 0;
  private degraded: boolean = false;
  private pendingSteps: Step[] = [];
  private pendingCandidates: Array<{ stepId: string; candidates: Candidate[] }> = [];

  constructor(config: Partial<XRayConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  async run<T>(
    pipelineName: string,
    pipelineVersion: string,
    fn: () => Promise<T>,
    options: RunOptions = {}
  ): Promise<T> {
    const runId = uuidv4();
    const run: Run = {
      runId,
      pipelineName,
      pipelineVersion,
      environment: options.environment || Environment.PROD,
      startedAt: new Date(),
      metadata: options.metadata
    };

    this.currentRunId = runId;
    this.currentRun = run;
    this.stepPosition = 0;

    try {
      await this.ingestRun(run);
      const result = await fn();
      
      if (this.currentRun) {
        this.currentRun.endedAt = new Date();
        await this.ingestRun(this.currentRun);
      }
      
      return result;
    } catch (error) {
      if (this.currentRun) {
        this.currentRun.endedAt = new Date();
        await this.ingestRun(this.currentRun);
      }
      throw error;
    } finally {
      await this.flush();
      this.currentRunId = null;
      this.currentRun = null;
      this.stepPosition = 0;
    }
  }

  async step<T>(
    stepType: StepType,
    stepName: string,
    fn: () => Promise<T>,
    options: StepOptions = {}
  ): Promise<T> {
    if (!this.currentRunId) {
      return fn();
    }

    const stepId = uuidv4();
    const position = this.stepPosition++;
    const captureLevel = options.captureLevel || this.config.defaultCaptureLevel;
    const startedAt = new Date();

    let candidatesIn = 0;
    let candidatesOut = 0;
    let result: T;

    try {
      result = await fn();
      
      if (Array.isArray(result)) {
        candidatesOut = result.length;
        if (options.candidates) {
          candidatesIn = options.candidates.length;
        } else {
          candidatesIn = candidatesOut;
        }
      } else if (result && typeof result === 'object' && 'length' in result) {
        candidatesOut = (result as unknown as { length: number }).length;
        candidatesIn = options.candidates?.length || candidatesOut;
      } else {
        candidatesIn = 1;
        candidatesOut = 1;
      }

      const dropRatio = candidatesIn > 0 ? 1 - candidatesOut / candidatesIn : 0;
      const endedAt = new Date();

      const step: Step = {
        stepId,
        runId: this.currentRunId,
        stepType,
        stepName,
        position,
        metrics: options.metrics || {},
        candidatesIn,
        candidatesOut,
        dropRatio,
        captureLevel,
        artifacts: options.artifacts,
        startedAt,
        endedAt
      };

      await this.ingestStep(step);

      if (captureLevel === CaptureLevel.FULL && options.candidates) {
        await this.ingestCandidates(stepId, options.candidates);
      }

      return result;
    } catch (error) {
      const endedAt = new Date();
      const step: Step = {
        stepId,
        runId: this.currentRunId!,
        stepType,
        stepName,
        position,
        metrics: options.metrics || {},
        candidatesIn,
        candidatesOut: 0,
        dropRatio: 1,
        captureLevel,
        artifacts: options.artifacts,
        startedAt,
        endedAt
      };
      await this.ingestStep(step);
      throw error;
    }
  }

  private async ingestRun(run: Run): Promise<void> {
    if (this.degraded || !this.config.apiUrl) {
      return;
    }

    try {
      const response = await fetch(`${this.config.apiUrl}/api/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
        },
        body: JSON.stringify({
          run_id: run.runId,
          pipeline_name: run.pipelineName,
          pipeline_version: run.pipelineVersion,
          environment: run.environment,
          started_at: run.startedAt.toISOString(),
          ended_at: run.endedAt?.toISOString(),
          metadata: run.metadata
        })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      if (this.config.degradeOnError) {
        this.handleDegradation();
      }
      throw error;
    }
  }

  private async ingestStep(step: Step): Promise<void> {
    if (this.degraded || !this.config.apiUrl) {
      return;
    }

    if (this.config.enableAsyncIngestion) {
      this.pendingSteps.push(step);
      return;
    }

    try {
      const response = await fetch(`${this.config.apiUrl}/api/v1/steps`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
        },
        body: JSON.stringify({
          step_id: step.stepId,
          run_id: step.runId,
          step_type: step.stepType,
          step_name: step.stepName,
          position: step.position,
          metrics: step.metrics,
          candidates_in: step.candidatesIn,
          candidates_out: step.candidatesOut,
          drop_ratio: step.dropRatio,
          capture_level: step.captureLevel,
          artifacts: step.artifacts,
          started_at: step.startedAt.toISOString(),
          ended_at: step.endedAt?.toISOString()
        })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      if (this.config.degradeOnError) {
        this.handleDegradation();
      }
    }
  }

  private async ingestCandidates(stepId: string, candidates: Candidate[]): Promise<void> {
    if (this.degraded || !this.config.apiUrl) {
      return;
    }

    if (this.config.enableAsyncIngestion) {
      this.pendingCandidates.push({ stepId, candidates });
      return;
    }

    try {
      const response = await fetch(`${this.config.apiUrl}/api/v1/candidates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
        },
        body: JSON.stringify({
          step_id: stepId,
          candidates: candidates.map(c => ({
            candidate_id: c.candidateId,
            content: c.content,
            metadata: c.metadata
          }))
        })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      if (this.config.degradeOnError) {
        this.handleDegradation();
      }
    }
  }

  private async flush(): Promise<void> {
    if (this.degraded || !this.config.apiUrl) {
      return;
    }

    const stepsToFlush = this.pendingSteps.filter(s => Object.keys(s).length > 0);
    const candidatesToFlush = this.pendingCandidates;

    this.pendingSteps = [];
    this.pendingCandidates = [];

    try {
      if (stepsToFlush.length > 0) {
        await Promise.all(stepsToFlush.map(step => this.ingestStep(step)));
      }
      if (candidatesToFlush.length > 0) {
        await Promise.all(
          candidatesToFlush.map(({ stepId, candidates }) =>
            this.ingestCandidates(stepId, candidates)
          )
        );
      }
    } catch (error) {
      if (this.config.degradeOnError) {
        this.handleDegradation();
      }
    }
  }

  private handleDegradation(): void {
    if (!this.degraded) {
      this.degraded = true;
    }
  }
}

