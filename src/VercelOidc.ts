/**
 * The OIDC token Vercel issues to a deployment.
 *
 * In Functions the token arrives on each request as the `x-vercel-oidc-token`
 * header and rotates, so it is read on every run of `token`/`find`, never
 * cached. In builds and after `vercel env pull` it is `VERCEL_OIDC_TOKEN`.
 * Use it to authenticate to the AI Gateway, or exchange it for cloud
 * credentials (AWS `AssumeRoleWithWebIdentity`, GCP workload identity
 * federation).
 *
 * @example
 * ```ts
 * import { VercelOidc } from "effect-vercel/oidc"
 * import { Effect, Redacted } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const token = yield* VercelOidc.token
 *   // pass Redacted.value(token) as the web identity token
 * })
 * ```
 */

import { Config, Data, Effect, Option, Redacted } from "effect"

/** The environment variable read when no request carries a token. */
export const TOKEN_ENV = "VERCEL_OIDC_TOKEN"

/** No usable OIDC token. */
export class VercelOidcError extends Data.TaggedError("VercelOidcError")<{
  readonly message: string
  readonly hints: ReadonlyArray<string>
  readonly cause?: unknown
}> {}

/** How to make a token available. */
export const hints: ReadonlyArray<string> = [
  "Run on Vercel, where each request carries an OIDC token.",
  `Or run \`vercel env pull\` locally to populate ${TOKEN_ENV}.`,
]

/**
 * Vercel exposes the current request's context on a well-known global symbol.
 * In Functions, the `x-vercel-oidc-token` header of the request lives there.
 * Mirrors `@vercel/oidc`'s `getVercelOidcTokenSync`, minus the dev-time
 * refresh that package also offers.
 */
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context")

type RequestContext = { readonly headers?: Record<string, string | undefined> }

const fromRequestContext = Effect.sync(() => {
  const holder = globalThis as typeof globalThis & {
    [REQUEST_CONTEXT]?: { get?: () => RequestContext | undefined }
  }
  return Option.fromNullishOr(
    holder[REQUEST_CONTEXT]?.get?.()?.headers?.["x-vercel-oidc-token"],
  ).pipe(Option.map(Redacted.make))
})

const fromEnv = Config.option(Config.redacted(TOKEN_ENV)).pipe(
  Effect.catchTag(
    "ConfigError",
    (cause) => new VercelOidcError({ message: `Failed to read ${TOKEN_ENV}.`, hints, cause }),
  ),
)

/**
 * The token if one is available: the request header, else `VERCEL_OIDC_TOKEN`.
 * `None` means neither is set, so a caller can fall back to something else.
 */
export const find: Effect.Effect<
  Option.Option<Redacted.Redacted<string>>,
  VercelOidcError
> = Effect.flatMap(fromRequestContext, (found) =>
  Option.isSome(found) ? Effect.succeed(found) : fromEnv,
)

/** Like `find`, but fails when no token is available. */
export const token: Effect.Effect<Redacted.Redacted<string>, VercelOidcError> = Effect.flatMap(
  find,
  Option.match({
    onNone: () =>
      Effect.fail(new VercelOidcError({ message: "No Vercel OIDC token is available.", hints })),
    onSome: Effect.succeed,
  }),
)
