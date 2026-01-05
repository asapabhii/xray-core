import { XRayClient } from './client';
import { StepType, CaptureLevel, Environment } from './types';
import { XRayConfig, defaultConfig } from './config';

let defaultClient = new XRayClient();

export const xray = {
  run: <T>(
    pipelineName: string,
    pipelineVersion: string,
    fn: () => Promise<T>,
    options?: { environment?: Environment; metadata?: Record<string, unknown> }
  ) => defaultClient.run(pipelineName, pipelineVersion, fn, options),

  step: <T>(
    stepType: StepType,
    stepName: string,
    fn: () => Promise<T>,
    options?: {
      captureLevel?: CaptureLevel;
      candidates?: Array<{ candidateId: string; content?: unknown; metadata?: Record<string, unknown> }>;
      artifacts?: Record<string, unknown>;
      metrics?: Record<string, string | number | boolean>;
    }
  ) => defaultClient.step(stepType, stepName, fn, options),

  /**
   * Configure X-Ray SDK behavior.
   * Configuration is global and affects all subsequent runs.
   * Creates a new client instance with the updated configuration.
   */
  configure: (config: Partial<XRayConfig>) => {
    Object.assign(defaultConfig, config);
    // Recreate client with new config
    defaultClient = new XRayClient(defaultConfig);
  }
};

export { XRayClient, StepType, CaptureLevel, Environment };
export type { Run, Step, Candidate, StepOptions, RunOptions } from './types';
export type { XRayConfig } from './config';

