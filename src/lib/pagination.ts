import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  // Cap at 2000 — high enough that operators can see big chunks of
  // shipped/awaiting at once (the OrdersView dropdown exposes 25/50/
  // 100/200/500/1000/2000), low enough that one request doesn't pull
  // 30k rows and time out under load. If a use case ever needs more
  // than 2000 in a single response, the right answer is server-side
  // streaming or virtualized scrolling, not bumping this further.
  pageSize: z.coerce.number().int().positive().max(2000).default(50),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function offsetOf({ page, pageSize }: Pagination) {
  return (page - 1) * pageSize;
}

export function paginated<T>(
  data: T[],
  total: number,
  { page, pageSize }: Pagination
) {
  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}
