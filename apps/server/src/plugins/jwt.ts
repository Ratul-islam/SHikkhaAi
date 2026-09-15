import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import { env } from "../config/env";

export default fp(async function jwtPlugin(app: FastifyInstance) {
  await app.register(fastifyCookie);

  // Access tokens are verified via app.jwt (Authorization: Bearer header).
  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: "15m" },
  });
});
