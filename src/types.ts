export enum StepType {
  INPUT = 'INPUT',
  GENERATION = 'GENERATION',
  RETRIEVAL = 'RETRIEVAL',
  FILTER = 'FILTER',
  RANKING = 'RANKING',
  EVALUATION = 'EVALUATION',
  SELECTION = 'SELECTION'
}

export enum CaptureLevel {
  NONE = 'NONE',
  SUMMARY = 'SUMMARY',
  FULL = 'FULL'
}

export enum Environment {
  DEV = 'dev',
  STAGING = 'staging',
  PROD = 'prod'
}

export interface RunMetadata {
  [key: string]: unknown;
}

export interface StepMetrics {
  [key: string]: string | number | boolean;
}

export interface DecisionArtifacts {
  [key: string]: unknown;
}

export interface Candidate {
  candidateId: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
}

export interface Run {
  runId: string;
  pipelineName: string;
  pipelineVersion: string;
  environment: Environment;
  startedAt: Date;
  endedAt?: Date;
  metadata?: RunMetadata;
}

export interface Step {
  stepId: string;
  runId: string;
  stepType: StepType;
  stepName: string;
  position: number;
  metrics: StepMetrics;
  candidatesIn: number;
  candidatesOut: number;
  dropRatio: number;
  captureLevel: CaptureLevel;
  artifacts?: DecisionArtifacts;
  startedAt: Date;
  endedAt?: Date;
}

export interface StepOptions {
  captureLevel?: CaptureLevel;
  candidates?: Candidate[];
  artifacts?: DecisionArtifacts;
  metrics?: StepMetrics;
}

export interface RunOptions {
  environment?: Environment;
  metadata?: RunMetadata;
}

