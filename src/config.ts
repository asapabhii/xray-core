import { CaptureLevel } from './types';

export interface XRayConfig {
  apiUrl?: string;
  apiKey?: string; // Optional, not used in reference implementation (auth out of scope)
  defaultCaptureLevel: CaptureLevel;
  enableAsyncIngestion: boolean;
  batchSize: number;
  flushIntervalMs: number;
  degradeOnError: boolean;
}

export const defaultConfig: XRayConfig = {
  defaultCaptureLevel: CaptureLevel.NONE,
  enableAsyncIngestion: true,
  batchSize: 100,
  flushIntervalMs: 5000,
  degradeOnError: true
};

