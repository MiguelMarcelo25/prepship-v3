import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
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
