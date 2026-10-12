import { QueryClient } from "@tanstack/react-query";

// List queries whose filters change should pass `placeholderData: keepPreviousData` so a refetch
// keeps the previous render; it is not a default because a detail page must never show the
// previous call's data under a new id.

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Realtime invalidates on change, so cached data stays fresh without background churn.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          // A permission error will not fix itself on retry.
          const msg = error instanceof Error ? error.message.toLowerCase() : "";
          if (msg.includes("permission denied") || msg.includes("jwt")) return false;
          return failureCount < 2;
        },
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
