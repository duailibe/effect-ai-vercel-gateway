import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Option, Redacted } from "effect"
import { VercelOidc } from "../src/oidc.js"

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context")

const withEnv = (env: Record<string, string | undefined>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))

const withRequestContext = <A, E, R>(token: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const holder = globalThis as Record<PropertyKey, unknown>
      holder[REQUEST_CONTEXT] = { get: () => ({ headers: { "x-vercel-oidc-token": token } }) }
      return holder
    }),
    () => effect,
    (holder) => Effect.sync(() => delete holder[REQUEST_CONTEXT]),
  )

describe("VercelOidc", () => {
  it.effect("prefers the request context header over the env var", () =>
    withRequestContext(
      "from-request",
      Effect.gen(function* () {
        const token = yield* VercelOidc.token.pipe(withEnv({ VERCEL_OIDC_TOKEN: "from-env" }))
        assert.strictEqual(Redacted.value(token), "from-request")
      }),
    ),
  )

  it.effect("falls back to VERCEL_OIDC_TOKEN", () =>
    Effect.gen(function* () {
      const token = yield* VercelOidc.token.pipe(withEnv({ VERCEL_OIDC_TOKEN: "from-env" }))
      assert.strictEqual(Redacted.value(token), "from-env")
    }),
  )

  it.effect("find is None and token fails when nothing is set", () =>
    Effect.gen(function* () {
      const found = yield* VercelOidc.find.pipe(withEnv({}))
      assert.isTrue(Option.isNone(found))
      const error = yield* VercelOidc.token.pipe(withEnv({}), Effect.flip)
      assert.strictEqual(error._tag, "VercelOidcError")
      assert.isAbove(error.hints.length, 0)
    }),
  )
})
