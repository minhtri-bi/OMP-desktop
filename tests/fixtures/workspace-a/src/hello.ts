// Sample source fixture for OMP Desktop source-viewer and line-anchor checks.

export interface GreetingOptions {
  target: string;
  excited?: boolean;
}

export function formatGreeting(options: GreetingOptions): string {
  const suffix = options.excited ? "!" : ".";
  return `Hello, ${options.target}${suffix}`;
}

export const WORKSPACE_A_MARKER = "WORKSPACE_A_HELLO_TS";
