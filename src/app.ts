import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pinoHttp from "pino-http"
import { config } from "./config";
export const logger=pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
});

export const app = express();

app.set("trust proxy", 1); // we're behind a load balancer in production
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 100 }));


// Liveness: is the process up?
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));


app.use((_req, res) => res.status(404).json({ error: "Not found" }));

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  req.log.error(err);
  res.status(500).json({ error: "Internal server error" }); // never leak internals
};
app.use(errorHandler);