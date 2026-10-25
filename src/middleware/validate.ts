import type { RequestHandler } from "express";
import type { ZodType } from "zod";
export const vallidateBody=<T>(schema: ZodType<T>): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: "Invalid request", issues: result.error.issues });
      return;
    }
    req.body = result.data;
    next();
  };