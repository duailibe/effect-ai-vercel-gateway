/**
 * Vercel AI Gateway as an Anthropic Messages API client for Effect AI.
 *
 * The gateway serves the Anthropic Messages API at its root URL and accepts
 * any model it lists, named `provider/model` (for example
 * `anthropic/claude-sonnet-4.5` or `google/gemini-2.5-flash`). Effect AI's
 * Anthropic provider only needs the base URL and the credential swapped, plus
 * two small dialect fixes (see `dropNullCacheControl` and
 * `fillMissingResponseKeys`), so this module is the one place the gateway is
 * configured.
 *
 * Structured output (`output_config.format`) works for every provider behind
 * the gateway, so the Anthropic provider's default of native structured
 * output holds for models it does not recognise.
 *
 * @example
 * ```ts
 * import { AiGateway } from "effect-vercel/ai-gateway"
 * import { AnthropicLanguageModel } from "@effect/ai-anthropic"
 * import { Layer } from "effect"
 * import { FetchHttpClient } from "effect/unstable/http"
 *
 * const Model = AnthropicLanguageModel.layer({ model: "anthropic/claude-sonnet-4.5" }).pipe(
 *   Layer.provide(AiGateway.layer),
 *   Layer.provide(FetchHttpClient.layer),
 * )
 * ```
 */

import { AnthropicClient } from "@effect/ai-anthropic"
import { Effect, Layer } from "effect"
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import * as AiGatewayCredentials from "./AiGatewayCredentials.js"

/** Base URL of the Vercel AI Gateway. */
export const AI_GATEWAY_URL = "https://ai-gateway.vercel.sh"

/**
 * Builds the Anthropic client against the gateway, authenticating each
 * request with `credentials`. A credential failure fails that request as an
 * `HttpClientError`, which Effect AI surfaces as a network `AiError`.
 */
export const make = (credentials: typeof AiGatewayCredentials.AiGatewayCredentials.Service) =>
  AnthropicClient.make({
    apiUrl: AI_GATEWAY_URL,
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequestEffect(authenticate(credentials)),
        HttpClient.mapRequest(dropNullCacheControl),
        HttpClient.transformResponse(Effect.flatMap(fillMissingResponseKeys)),
      ),
  })

/**
 * `AnthropicClient` backed by the gateway, authenticating with the
 * `AiGatewayCredentials` you provide (see that module's `layerFrom*` layers).
 * Needs an `HttpClient` too.
 */
export const layerWithoutCredentials: Layer.Layer<
  AnthropicClient.AnthropicClient,
  never,
  AiGatewayCredentials.AiGatewayCredentials | HttpClient.HttpClient
> = Layer.effect(AnthropicClient.AnthropicClient)(
  Effect.flatMap(Effect.service(AiGatewayCredentials.AiGatewayCredentials), make),
)

/**
 * `layerWithoutCredentials` with the default `AiGatewayCredentials.layer`:
 * `AI_GATEWAY_API_KEY`, else the Vercel OIDC token. Needs an `HttpClient`.
 * Building never fails; without a usable credential, the requests fail.
 */
export const layer: Layer.Layer<AnthropicClient.AnthropicClient, never, HttpClient.HttpClient> =
  layerWithoutCredentials.pipe(Layer.provide(AiGatewayCredentials.layer))

function authenticate(credentials: typeof AiGatewayCredentials.AiGatewayCredentials.Service) {
  return (request: HttpClientRequest.HttpClientRequest) =>
    credentials.pipe(
      Effect.map((resolved) =>
        HttpClientRequest.setHeaders(request, AiGatewayCredentials.formatHeaders(resolved)),
      ),
      Effect.mapError(
        (error) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: error,
              description: "AI Gateway credential unavailable",
            }),
          }),
      ),
    )
}

/**
 * The Effect provider writes `"cache_control": null` on every content block
 * it has no cache setting for. Anthropic accepts that; the gateway rejects
 * the request with `messages.0.content: Invalid input`. Remove the null keys.
 */
export function dropNullCacheControl(
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest {
  const body = request.body
  if (body._tag !== "Uint8Array" || !isJson(body.contentType)) {
    return request
  }
  const json: unknown = JSON.parse(new TextDecoder().decode(body.body))
  return HttpClientRequest.setBody(
    request,
    HttpBody.jsonUnsafe(withoutNullCacheControl(json), body.contentType),
  )
}

function withoutNullCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNullCacheControl)
  if (value === null || typeof value !== "object") return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === "cache_control" && entry === null) continue
    result[key] = withoutNullCacheControl(entry)
  }
  return result
}

/**
 * The gateway's Anthropic-shaped responses leave out keys that Anthropic
 * always sends and the Effect provider's schema requires: the cache and
 * service-tier usage fields, the `signature` of a thinking block from a
 * non-Anthropic model, and `type`/`request_id` on error envelopes, whose
 * `error.type` may also be a gateway-specific value. Fill them with the values
 * Anthropic uses when there is nothing to report. Streaming responses are not
 * JSON and pass through untouched.
 */
export function fillMissingResponseKeys(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> {
  if (!isJson(response.headers["content-type"] ?? "")) {
    return Effect.succeed(response)
  }
  return Effect.map(response.text, (text) => {
    const body = JSON.parse(text) as Record<string, unknown>
    return HttpClientResponse.fromWeb(
      response.request,
      new Response(JSON.stringify(patchResponseBody(body)), {
        status: response.status,
        headers: response.headers,
      }),
    )
  })
}

export function patchResponseBody(body: Record<string, unknown>): Record<string, unknown> {
  if (body.type === "message") {
    const usage = (body.usage ?? {}) as Record<string, unknown>
    body.usage = {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      service_tier: null,
      ...usage,
    }
    if (Array.isArray(body.content)) {
      body.content = body.content.map((block: unknown) =>
        isRecord(block) && block.type === "thinking" ? { signature: "", ...block } : block,
      )
    }
    return body
  }
  if (isRecord(body.error)) {
    const error = ANTHROPIC_ERROR_TYPES.has(String(body.error.type))
      ? body.error
      : { ...body.error, type: "api_error" }
    return { type: "error", request_id: null, ...body, error }
  }
  return body
}

const ANTHROPIC_ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "timeout_error",
  "api_error",
  "overloaded_error",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJson(contentType: string): boolean {
  return contentType.startsWith("application/json")
}
