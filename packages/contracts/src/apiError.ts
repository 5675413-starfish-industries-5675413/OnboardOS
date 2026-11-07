import { z } from "zod";

/**
 * Standard API error envelope returned on all 4xx/5xx responses.
 * `requestId` is the Lambda/API Gateway request ID for correlation.
 */
export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
