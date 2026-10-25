import "dotenv/config"
import {z} from "zod"

const schema=z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  CORS_ORIGIN: z.string().default("*"),
  DB_POOL_MAX: z.coerce.number().default(10),
})
export const config=schema.parse(process.env)