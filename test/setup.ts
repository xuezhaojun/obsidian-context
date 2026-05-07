// Make `window.*` timer calls resolve to the same global timers that
// vi.useFakeTimers() patches.
(global as unknown as Record<string, unknown>).window = global;
