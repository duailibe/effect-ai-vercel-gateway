/**
 * How gateway requests authenticate.
 *
 * `AiGatewayCredentials` holds an effect that produces the credential for one
 * request. It runs per request rather than once at startup: on Vercel the OIDC
 * token arrives on the request context and rotates, so it must not be cached.
 * `layer` is the default; pick a `layerFrom*` layer to use one source only.
 *
 * @example
 * ```ts
 * import { AiGatewayCredentials } from "effect-vercel/ai-gateway"
 *
 * AiGatewayCredentials.layer           // AI_GATEWAY_API_KEY, else the Vercel OIDC token
 * AiGatewayCredentials.layerFromEnv         // AI_GATEWAY_API_KEY only
 * AiGatewayCredentials.layerFromVercelOidc  // the Vercel OIDC token only
 * AiGatewayCredentials.layerFromApiKey("…") // a fixed value
 * ```
 */

import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect"
import * as VercelOidc from "./VercelOidc.js"

/** The environment variable `layerFromEnv` reads. */
export const API_KEY_ENV = "AI_GATEWAY_API_KEY"

/** Which layer produced or failed to produce a credential. */
export type Source = "api-key" | "env" | "vercel-oidc" | "default"

/**
 * A credential ready to put on a request. `method` is what the gateway
 * records as the auth method; it matches the values Vercel's own SDK sends.
 */
export interface Resolved {
  readonly method: "api-key" | "oidc"
  readonly token: Redacted.Redacted<string>
}

/** No credential could be produced for a gateway request. */
export class AiGatewayCredentialsError extends Data.TaggedError("AiGatewayCredentialsError")<{
  readonly message: string
  readonly source: Source
  readonly hints: ReadonlyArray<string>
  readonly cause?: unknown
}> {}

export class AiGatewayCredentials extends Context.Service<
  AiGatewayCredentials,
  Effect.Effect<Resolved, AiGatewayCredentialsError>
>()("effect-vercel/ai-gateway/AiGatewayCredentials") {}

/** The request headers that carry `credentials`. */
export const formatHeaders = (credentials: Resolved): Record<string, string> => ({
  "x-api-key": Redacted.value(credentials.token),
  "ai-gateway-auth-method": credentials.method,
})

const hints: Record<Source, ReadonlyArray<string>> = {
  "api-key": [],
  env: [`Set ${API_KEY_ENV} to an AI Gateway API key.`],
  "vercel-oidc": VercelOidc.hints,
  default: [
    `Set ${API_KEY_ENV} to an AI Gateway API key.`,
    "Or run on Vercel / `vercel env pull` so an OIDC token is available.",
  ],
}

/**
 * Where a credential may come from. `None` means the place is not configured,
 * so a chain can move on; a failure means it is configured but unusable.
 */
type Lookup = Effect.Effect<Option.Option<Resolved>, AiGatewayCredentialsError>

const apiKeyLookup: Lookup = Config.option(Config.redacted(API_KEY_ENV)).pipe(
  Effect.map(Option.map((token) => ({ method: "api-key" as const, token }))),
  Effect.catchTag(
    "ConfigError",
    (cause) =>
      new AiGatewayCredentialsError({
        message: `Failed to read ${API_KEY_ENV}.`,
        source: "env",
        hints: hints.env,
        cause,
      }),
  ),
)

const vercelOidcLookup: Lookup = VercelOidc.find.pipe(
  Effect.map(Option.map((token) => ({ method: "oidc" as const, token }))),
  Effect.mapError(
    (cause) =>
      new AiGatewayCredentialsError({
        message: cause.message,
        source: "vercel-oidc",
        hints: cause.hints,
        cause,
      }),
  ),
)

const firstOf = (lookups: ReadonlyArray<Lookup>): Lookup =>
  Effect.gen(function* () {
    for (const lookup of lookups) {
      const found = yield* lookup
      if (Option.isSome(found)) return found
    }
    return Option.none()
  })

const toLayer = (lookup: Lookup, source: Source, message: string) =>
  Layer.succeed(AiGatewayCredentials)(
    Effect.flatMap(lookup, (found) =>
      Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.fail(new AiGatewayCredentialsError({ message, source, hints: hints[source] })),
    ),
  )

/** A fixed API key. */
export const layerFromApiKey = (
  apiKey: string | Redacted.Redacted<string>,
): Layer.Layer<AiGatewayCredentials> =>
  Layer.succeed(AiGatewayCredentials)(
    Effect.succeed({
      method: "api-key",
      token: Redacted.isRedacted(apiKey) ? apiKey : Redacted.make(apiKey),
    }),
  )

/** `AI_GATEWAY_API_KEY`: local dev, CI, or anywhere off Vercel. */
export const layerFromEnv: Layer.Layer<AiGatewayCredentials> = toLayer(
  apiKeyLookup,
  "env",
  `${API_KEY_ENV} is not set.`,
)

/** The Vercel OIDC token (see `VercelOidc.find`). Not refreshed when it expires locally. */
export const layerFromVercelOidc: Layer.Layer<AiGatewayCredentials> = toLayer(
  vercelOidcLookup,
  "vercel-oidc",
  "No Vercel OIDC token is available.",
)

/**
 * The default: `layerFromEnv`, then `layerFromVercelOidc`. Same order as
 * Vercel's own SDK, so it works locally with an API key and on Vercel without
 * one.
 */
export const layer: Layer.Layer<AiGatewayCredentials> = toLayer(
  firstOf([apiKeyLookup, vercelOidcLookup]),
  "default",
  "No AI Gateway credential found.",
)
