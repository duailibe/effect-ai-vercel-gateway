import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { Credentials } from "../src/index.js"

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context")

const withEnv = (env: Record<string, string | undefined>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))

const resolve = (layer: Layer.Layer<Credentials.Credentials>) =>
  Effect.flatten(Effect.service(Credentials.Credentials)).pipe(Effect.provide(layer))

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

describe("Credentials", () => {
  describe("fromApiKey", () => {
    it.effect("resolves the given key", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(Credentials.fromApiKey("key"))
        assert.deepStrictEqual(resolved, { method: "api-key", token: Redacted.make("key") })
        const redacted = yield* resolve(Credentials.fromApiKey(Redacted.make("key2")))
        assert.strictEqual(Redacted.value(redacted.token), "key2")
      }),
    )
  })

  describe("fromEnv", () => {
    it.effect("reads AI_GATEWAY_API_KEY", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(Credentials.fromEnv()).pipe(
          withEnv({ AI_GATEWAY_API_KEY: "key", VERCEL_OIDC_TOKEN: "oidc" }),
        )
        assert.strictEqual(resolved.method, "api-key")
        assert.strictEqual(Redacted.value(resolved.token), "key")
      }),
    )

    it.effect("ignores the OIDC token", () =>
      Effect.gen(function* () {
        const error = yield* resolve(Credentials.fromEnv()).pipe(
          withEnv({ VERCEL_OIDC_TOKEN: "oidc" }),
          Effect.flip,
        )
        assert.strictEqual(error._tag, "AiGatewayCredentialsError")
        assert.strictEqual(error.source, "env")
      }),
    )
  })

  describe("fromVercelOidc", () => {
    it.effect("prefers the request context header over the env var", () =>
      withRequestContext(
        "from-request",
        Effect.gen(function* () {
          const resolved = yield* resolve(Credentials.fromVercelOidc()).pipe(
            withEnv({ VERCEL_OIDC_TOKEN: "from-env" }),
          )
          assert.strictEqual(resolved.method, "oidc")
          assert.strictEqual(Redacted.value(resolved.token), "from-request")
        }),
      ),
    )

    it.effect("falls back to VERCEL_OIDC_TOKEN", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(Credentials.fromVercelOidc()).pipe(
          withEnv({ VERCEL_OIDC_TOKEN: "from-env" }),
        )
        assert.strictEqual(Redacted.value(resolved.token), "from-env")
      }),
    )

    it.effect("ignores AI_GATEWAY_API_KEY", () =>
      Effect.gen(function* () {
        const error = yield* resolve(Credentials.fromVercelOidc()).pipe(
          withEnv({ AI_GATEWAY_API_KEY: "key" }),
          Effect.flip,
        )
        assert.strictEqual(error.source, "vercel-oidc")
      }),
    )
  })

  describe("fromChain", () => {
    it.effect("prefers AI_GATEWAY_API_KEY", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(Credentials.fromChain()).pipe(
          withEnv({ AI_GATEWAY_API_KEY: "key", VERCEL_OIDC_TOKEN: "oidc" }),
        )
        assert.strictEqual(resolved.method, "api-key")
      }),
    )

    it.effect("falls back to the OIDC token", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(Credentials.fromChain()).pipe(
          withEnv({ VERCEL_OIDC_TOKEN: "oidc" }),
        )
        assert.strictEqual(resolved.method, "oidc")
      }),
    )

    it.effect("fails with hints when nothing is configured", () =>
      Effect.gen(function* () {
        const error = yield* resolve(Credentials.fromChain()).pipe(withEnv({}), Effect.flip)
        assert.strictEqual(error.source, "chain")
        assert.isAbove(error.hints.length, 0)
      }),
    )

    it.effect("resolves per call, not once", () =>
      Effect.gen(function* () {
        const credentials = yield* Effect.service(Credentials.Credentials).pipe(
          Effect.provide(Credentials.fromChain()),
        )
        const first = yield* credentials.pipe(withEnv({ AI_GATEWAY_API_KEY: "one" }))
        const second = yield* credentials.pipe(withEnv({ AI_GATEWAY_API_KEY: "two" }))
        assert.strictEqual(Redacted.value(first.token), "one")
        assert.strictEqual(Redacted.value(second.token), "two")
      }),
    )
  })

  it("formatHeaders", () => {
    assert.deepStrictEqual(
      Credentials.formatHeaders({ method: "oidc", token: Redacted.make("t") }),
      { "x-api-key": "t", "ai-gateway-auth-method": "oidc" },
    )
  })
})
