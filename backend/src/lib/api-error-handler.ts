import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { ApiResponse } from "../../../shared/src/types.js";

/**
 * A rejected body must still answer in the ApiResponse shape { ok, error } —
 * every client checks `ok`, and Fastify's default validation error carries no
 * such field. Registered app-wide so a schema added to any route stays
 * contract-compatible.
 */
export function apiErrorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
): ApiResponse {
  if (err.validation) {
    req.log.warn(
      { tag: "http", event: "body_rejected", url: req.url, err_msg: err.message },
      `Rejected body for ${req.url}: ${err.message}`,
    );
    reply.status(400);
    return { ok: false, error: `Ungültige Anfrage: ${err.message}` };
  }
  reply.status(err.statusCode ?? 500);
  return { ok: false, error: err.message };
}
