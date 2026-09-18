/**
 * How gateway requests authenticate.
 *
 * `Credentials` holds an effect that produces the credential for one request.
 * It runs per request rather than once at startup: on Vercel the OIDC token
 * arrives on the request context and rotates, so it must not be cached. Pick
 * a `from*` layer for where the credential comes from.
 *
 * @example
 * ```ts
 * import { Credentials } from "effect-ai-vercel-gateway"
 *
 * Credentials.fromChain()      // AI_GATEWAY_API_KEY, else the Vercel OIDC token
 * Credentials.fromEnv()        // AI_GATEWAY_API_KEY only
 * Credentials.fromVercelOidc() // the Vercel OIDC token only
 * Credentials.fromApiKey("…")  // a fixed value
 * ```
 */

import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect"

/** The environment variable `fromEnv` reads. */
export const API_KEY_ENV = "AI_GATEWAY_API_KEY"

/** The environment variable `fromVercelOidc` falls back to. */
export const OIDC_TOKEN_ENV = "VERCEL_OIDC_TOKEN"

/** Which `from*` layer produced or failed to produce a credential. */
export type Source = "api-key" | "env" | "vercel-oidc" | "chain"

/**
 * A credential ready to put on a request. `method` is what the gateway
 * records as the auth method; it matches the values Vercel's own SDK sends.
 */
export interface Resolved {
  readonly method: "api-key" | "oidc"
  readonly token: Redacted.Redacted<string>
}

/** No credential could be produced for a gateway request. */
export class CredentialsError extends Data.TaggedError("AiGatewayCredentialsError")<{
  readonly message: string
  readonly source: Source
  readonly hints: ReadonlyArray<string>
  readonly cause?: unknown
}> {}

export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<Resolved, CredentialsError>
>()("effect-ai-vercel-gateway/Credentials") {}

/** The request headers that carry `credentials`. */
export const formatHeaders = (credentials: Resolved): Record<string, string> => ({
  "x-api-key": Redacted.value(credentials.token),
  "ai-gateway-auth-method": credentials.method,
})

const hints: Record<Source, ReadonlyArray<string>> = {
  "api-key": [],
  env: [`Set ${API_KEY_ENV} to an AI Gateway API key.`],
  "vercel-oidc": [
    "Run on Vercel, where each request carries an OIDC token.",
    `Or run \`vercel env pull\` locally to populate ${OIDC_TOKEN_ENV}.`,
  ],
  chain: [
    `Set ${API_KEY_ENV} to an AI Gateway API key.`,
    "Or run on Vercel / `vercel env pull` so an OIDC token is available.",
  ],
}

/**
 * Where a credential may come from. `None` means the place is not configured,
 * so a chain can move on; a failure means it is configured but unusable.
 */
type Lookup = Effect.Effect<Option.Option<Resolved>, CredentialsError>

const fromConfig = (name: string, method: Resolved["method"], source: Source): Lookup =>
  Config.option(Config.redacted(name)).pipe(
    Effect.map(Option.map((token) => ({ method, token }))),
    Effect.catchTag(
      "ConfigError",
      (cause) =>
        new CredentialsError({
          message: `Failed to read ${name}.`,
          source,
          hints: hints[source],
          cause,
        }),
    ),
  )

/**
 * Vercel exposes the current request's context on a well-known global symbol.
 * In Functions, the `x-vercel-oidc-token` header of the request lives there.
 * Mirrors `@vercel/oidc`'s `getVercelOidcTokenSync`, minus the dev-time
 * refresh that package also offers.
 */
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context")

type RequestContext = { readonly headers?: Record<string, string | undefined> }

const fromRequestContext: Lookup = Effect.sync(() => {
  const holder = globalThis as typeof globalThis & {
    [REQUEST_CONTEXT]?: { get?: () => RequestContext | undefined }
  }
  const token = holder[REQUEST_CONTEXT]?.get?.()?.headers?.["x-vercel-oidc-token"]
  return token === undefined
    ? Option.none()
    : Option.some({ method: "oidc" as const, token: Redacted.make(token) })
})

const firstOf = (lookups: ReadonlyArray<Lookup>): Lookup =>
  Effect.gen(function* () {
    for (const lookup of lookups) {
      const found = yield* lookup
      if (Option.isSome(found)) return found
    }
    return Option.none()
  })

const require = (lookup: Lookup, source: Source, message: string) =>
  Layer.succeed(Credentials)(
    Effect.flatMap(lookup, (found) =>
      Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.fail(new CredentialsError({ message, source, hints: hints[source] })),
    ),
  )

const apiKeyLookup = fromConfig(API_KEY_ENV, "api-key", "env")

const vercelOidcLookup = firstOf([
  fromRequestContext,
  fromConfig(OIDC_TOKEN_ENV, "oidc", "vercel-oidc"),
])

/** A fixed API key. */
export const fromApiKey = (apiKey: string | Redacted.Redacted<string>): Layer.Layer<Credentials> =>
  Layer.succeed(Credentials)(
    Effect.succeed({
      method: "api-key",
      token: Redacted.isRedacted(apiKey) ? apiKey : Redacted.make(apiKey),
    }),
  )

/** `AI_GATEWAY_API_KEY`: local dev, CI, or anywhere off Vercel. */
export const fromEnv = (): Layer.Layer<Credentials> =>
  require(apiKeyLookup, "env", `${API_KEY_ENV} is not set.`)

/**
 * The OIDC token Vercel issues to the deployment: the `x-vercel-oidc-token`
 * header of the current request in Functions, else `VERCEL_OIDC_TOKEN` in
 * builds and after `vercel env pull`. Not refreshed when it expires locally.
 */
export const fromVercelOidc = (): Layer.Layer<Credentials> =>
  require(vercelOidcLookup, "vercel-oidc", "No Vercel OIDC token is available.")

/** `fromEnv`, then `fromVercelOidc`. The usual choice for an app deployed to Vercel. */
export const fromChain = (): Layer.Layer<Credentials> =>
  require(firstOf([apiKeyLookup, vercelOidcLookup]), "chain", "No AI Gateway credential found.")
