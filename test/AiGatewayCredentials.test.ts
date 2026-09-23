import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { AiGatewayCredentials } from "../src/ai-gateway.js"

const withEnv = (env: Record<string, string | undefined>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))

const resolve = (layer: Layer.Layer<AiGatewayCredentials.AiGatewayCredentials>) =>
  Effect.flatten(Effect.service(AiGatewayCredentials.AiGatewayCredentials)).pipe(
    Effect.provide(layer),
  )

describe("AiGatewayCredentials", () => {
  describe("layerFromApiKey", () => {
    it.effect("resolves the given key", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(AiGatewayCredentials.layerFromApiKey("key"))
        assert.deepStrictEqual(resolved, { method: "api-key", token: Redacted.make("key") })
        const redacted = yield* resolve(AiGatewayCredentials.layerFromApiKey(Redacted.make("key2")))
        assert.strictEqual(Redacted.value(redacted.token), "key2")
      }),
    )
  })

  describe("layerFromEnv", () => {
    it.effect("reads AI_GATEWAY_API_KEY", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(AiGatewayCredentials.layerFromEnv).pipe(
          withEnv({ AI_GATEWAY_API_KEY: "key", VERCEL_OIDC_TOKEN: "oidc" }),
        )
        assert.strictEqual(resolved.method, "api-key")
        assert.strictEqual(Redacted.value(resolved.token), "key")
      }),
    )

    it.effect("ignores the OIDC token", () =>
      Effect.gen(function* () {
        const error = yield* resolve(AiGatewayCredentials.layerFromEnv).pipe(
          withEnv({ VERCEL_OIDC_TOKEN: "oidc" }),
          Effect.flip,
        )
        assert.strictEqual(error._tag, "AiGatewayCredentialsError")
        assert.strictEqual(error.source, "env")
      }),
    )
  })

  describe("layerFromVercelOidc", () => {
    it.effect("falls back to VERCEL_OIDC_TOKEN", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(AiGatewayCredentials.layerFromVercelOidc).pipe(
          withEnv({ VERCEL_OIDC_TOKEN: "from-env" }),
        )
        assert.strictEqual(resolved.method, "oidc")
        assert.strictEqual(Redacted.value(resolved.token), "from-env")
      }),
    )

    it.effect("ignores AI_GATEWAY_API_KEY", () =>
      Effect.gen(function* () {
        const error = yield* resolve(AiGatewayCredentials.layerFromVercelOidc).pipe(
          withEnv({ AI_GATEWAY_API_KEY: "key" }),
          Effect.flip,
        )
        assert.strictEqual(error.source, "vercel-oidc")
      }),
    )
  })

  describe("layer", () => {
    it.effect("prefers AI_GATEWAY_API_KEY", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(AiGatewayCredentials.layer).pipe(
          withEnv({ AI_GATEWAY_API_KEY: "key", VERCEL_OIDC_TOKEN: "oidc" }),
        )
        assert.strictEqual(resolved.method, "api-key")
      }),
    )

    it.effect("falls back to the OIDC token", () =>
      Effect.gen(function* () {
        const resolved = yield* resolve(AiGatewayCredentials.layer).pipe(
          withEnv({ VERCEL_OIDC_TOKEN: "oidc" }),
        )
        assert.strictEqual(resolved.method, "oidc")
      }),
    )

    it.effect("fails with hints when nothing is configured", () =>
      Effect.gen(function* () {
        const error = yield* resolve(AiGatewayCredentials.layer).pipe(withEnv({}), Effect.flip)
        assert.strictEqual(error.source, "default")
        assert.isAbove(error.hints.length, 0)
      }),
    )

    it.effect("resolves per call, not once", () =>
      Effect.gen(function* () {
        const credentials = yield* Effect.service(AiGatewayCredentials.AiGatewayCredentials).pipe(
          Effect.provide(AiGatewayCredentials.layer),
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
      AiGatewayCredentials.formatHeaders({ method: "oidc", token: Redacted.make("t") }),
      { "x-api-key": "t", "ai-gateway-auth-method": "oidc" },
    )
  })
})
