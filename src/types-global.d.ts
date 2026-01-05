/// <reference types="node" />

declare global {
  // Fetch API types for Node.js 18+
  interface RequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }

  interface Response {
    ok: boolean;
    status: number;
    statusText: string;
    json(): Promise<unknown>;
  }

  // eslint-disable-next-line no-var
  var fetch: (url: string, options?: RequestInit) => Promise<Response>;
}

export {};

