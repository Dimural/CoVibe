import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(8080),
  redisUrl: z.string().url().optional(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  maxParticipants: z.coerce.number().int().min(2).max(16).default(4),
  sessionGraceMs: z.coerce.number().int().min(0).default(1_800_000),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  /** Optional Sentry DSN — when set, Sentry is initialized at startup. */
  sentryDsn: z.string().url().optional(),
});

export type Config = Readonly<z.infer<typeof ConfigSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    port: env.PORT,
    redisUrl: env.REDIS_URL,
    logLevel: env.LOG_LEVEL,
    maxParticipants: env.MAX_PARTICIPANTS,
    sessionGraceMs: env.SESSION_GRACE_MS,
    nodeEnv: env.NODE_ENV,
    sentryDsn: env.SENTRY_DSN,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid relay configuration: ${issues}`);
  }
  return Object.freeze(parsed.data);
}
