import { AnthropicLanguageModel } from "@effect/ai-anthropic"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AiGateway, AiGatewayCredentials } from "../src/ai-gateway.js"

const gatewayMessage = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "google/gemini-2.5-flash",
  content: [
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "hello" },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 5 },
}

/** An `HttpClient` that records the requests it receives and answers with `body`. */
function fakeHttpClient(body: unknown, status = 200) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const layer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) => {
      requests.push(request)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
    }),
  )
  return { requests, layer }
}

function decodeJsonBody(request: HttpClientRequest.HttpClientRequest): unknown {
  assert.strictEqual(request.body._tag, "Uint8Array")
  if (request.body._tag !== "Uint8Array") throw new Error("unreachable")
  return JSON.parse(new TextDecoder().decode(request.body.body))
}

const model = (
  id: string,
  credentials: Layer.Layer<AiGatewayCredentials.AiGatewayCredentials>,
  http: Layer.Layer<HttpClient.HttpClient>,
) =>
  AnthropicLanguageModel.layer({ model: id }).pipe(
    Layer.provide(AiGateway.layerWithoutCredentials),
    Layer.provide([credentials, http]),
  )

describe("dropNullCacheControl", () => {
  it("removes null cache_control keys and keeps set ones", () => {
    const request = HttpClientRequest.post("/v1/messages").pipe(
      HttpClientRequest.setBody(
        HttpBody.jsonUnsafe({
          system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hi", cache_control: null }],
              cache_control: null,
            },
          ],
        }),
      ),
    )
    assert.deepStrictEqual(decodeJsonBody(AiGateway.dropNullCacheControl(request)), {
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
  })

  it("leaves non-JSON bodies alone", () => {
    const request = HttpClientRequest.post("/x").pipe(
      HttpClientRequest.setBody(HttpBody.text("cache_control")),
    )
    assert.strictEqual(AiGateway.dropNullCacheControl(request), request)
  })
})

describe("patchResponseBody", () => {
  it("fills usage and thinking signature on messages", () => {
    const patched = AiGateway.patchResponseBody(structuredClone(gatewayMessage))
    assert.deepStrictEqual(patched.usage, {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      service_tier: null,
      input_tokens: 3,
      output_tokens: 5,
    })
    assert.deepStrictEqual(patched.content, [
      { type: "thinking", thinking: "hmm", signature: "" },
      { type: "text", text: "hello" },
    ])
  })

  it("does not override usage fields the gateway did send", () => {
    const patched = AiGateway.patchResponseBody({
      type: "message",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 42 },
    })
    assert.strictEqual((patched.usage as Record<string, unknown>).cache_read_input_tokens, 42)
  })

  it("completes error envelopes and maps unknown error types to api_error", () => {
    assert.deepStrictEqual(
      AiGateway.patchResponseBody({ error: { type: "gateway_error", message: "boom" } }),
      {
        type: "error",
        request_id: null,
        error: { type: "api_error", message: "boom" },
      },
    )
    assert.deepStrictEqual(
      AiGateway.patchResponseBody({
        type: "error",
        request_id: "req_1",
        error: { type: "rate_limit_error", message: "slow down" },
      }),
      {
        type: "error",
        request_id: "req_1",
        error: { type: "rate_limit_error", message: "slow down" },
      },
    )
  })
})

describe("layer", () => {
  it.effect("authenticates, patches the request, and decodes a gateway response", () =>
    Effect.gen(function* () {
      const http = fakeHttpClient(gatewayMessage)

      const response = yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
        Effect.provide(
          model(
            "google/gemini-2.5-flash",
            AiGatewayCredentials.layerFromApiKey("secret"),
            http.layer,
          ),
        ),
      )

      assert.strictEqual(response.text, "hello")
      assert.strictEqual(response.usage.inputTokens.total, 3)
      assert.strictEqual(http.requests.length, 1)
      const request = http.requests[0]!
      assert.isTrue(request.url.startsWith(`${AiGateway.AI_GATEWAY_URL}/v1/messages`))
      assert.strictEqual(request.headers["x-api-key"], "secret")
      assert.strictEqual(request.headers["ai-gateway-auth-method"], "api-key")
      assert.notInclude(JSON.stringify(decodeJsonBody(request)), '"cache_control":null')
    }),
  )

  it.effect("surfaces a credential failure as an AiError without sending", () =>
    Effect.gen(function* () {
      const http = fakeHttpClient(gatewayMessage)

      const error = yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
        Effect.provide(
          model("anthropic/claude-sonnet-4.5", AiGatewayCredentials.layerFromEnv, http.layer),
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})),
        Effect.flip,
      )

      assert.strictEqual(error._tag, "AiError")
      assert.strictEqual(http.requests.length, 0)
    }),
  )

  it.effect("decodes a gateway error envelope", () =>
    Effect.gen(function* () {
      const http = fakeHttpClient(
        { error: { type: "gateway_error", message: "no such model" } },
        404,
      )

      const error = yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
        Effect.provide(
          model("nope/nope", AiGatewayCredentials.layerFromApiKey("secret"), http.layer),
        ),
        Effect.flip,
      )

      assert.strictEqual(error._tag, "AiError")
      assert.include(error.message, "no such model")
    }),
  )
})
