import { createElement, lazy, type ComponentProps, type ComponentType } from "react";

/**
 * React.lazy caches a rejected import for good, so after a failed chunk load
 * (offline PWA, or a deploy that removed the old hashed chunk) an error
 * boundary's "Try again" re-throws forever. This wrapper starts a fresh lazy
 * component after a failure, so the next render imports again.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same constraint as React.lazy
export function retryingLazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): T {
  let current = lazy(attempt);
  function attempt(): Promise<{ default: T }> {
    return load().catch((error: unknown) => { current = lazy(attempt); throw error; });
  }
  function RetryingLazy(props: ComponentProps<T>) { return createElement(current, props); }
  return RetryingLazy as unknown as T;
}
