import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FRONTEND_DIST =
  process.env.FRONTEND_DIST ??
  path.resolve(__dirname, "../../../../frontend/dist");

export async function registerStatic(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: path.join(FRONTEND_DIST, "assets"),
    prefix: "/assets/",
    maxAge: "30d",
    immutable: true,
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: FRONTEND_DIST,
    prefix: "/",
    wildcard: false,
    globIgnore: ["assets/**"],
    maxAge: 0,
    cacheControl: true,
  });

  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "";
    if (url.startsWith("/api") || url.startsWith("/ws")) {
      return reply.code(404).send({ error: "Not Found" });
    }
    return reply.sendFile("index.html");
  });
}
