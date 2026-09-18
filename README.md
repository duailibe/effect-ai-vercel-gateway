# effect-ai-vercel-gateway

[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) as an `AnthropicClient` for
[Effect AI](https://effect.website) (`@effect/ai-anthropic`, Effect v4).

The gateway serves the Anthropic Messages API and routes to any model it lists, named
`provider/model`. This package points Effect AI's Anthropic provider at the gateway, handles
authentication per request, and smooths over the small differences between the gateway's
dialect and what the provider's schemas expect.

## Install

```sh
pnpm add effect-ai-vercel-gateway effect @effect/ai-anthropic
```

## Usage

```ts
import { AiGateway, Credentials } from "effect-ai-vercel-gateway"
import { AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"

const Model = AnthropicLanguageModel.layer({ model: "google/gemini-2.5-flash" }).pipe(
  Layer.provide(AiGateway.layer),
  Layer.provide([Credentials.fromChain(), FetchHttpClient.layer]),
)

const program = LanguageModel.generateText({ prompt: "Say hi" }).pipe(
  Effect.map((r) => r.text),
  Effect.provide(Model),
)
```

`AiGateway.layer` provides `AnthropicClient` and requires `Credentials` (below) and an
`HttpClient`.

Any Effect AI feature that works with the Anthropic provider (tools, structured output,
streaming, thinking) works through the gateway, for every model the gateway offers.

## Credentials

`Credentials` is a service holding an effect that resolves the credential on every request,
so a rotating token is always current. Pick a layer for where it comes from:

| Layer                          | Source                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Credentials.fromApiKey(key)`  | A fixed key. Tests, custom wiring.                                                                                                                                         |
| `Credentials.fromEnv()`        | `AI_GATEWAY_API_KEY`. Local dev, CI, anywhere off Vercel.                                                                                                                  |
| `Credentials.fromVercelOidc()` | The OIDC token Vercel issues to the deployment: the `x-vercel-oidc-token` header of the current request (Functions), else `VERCEL_OIDC_TOKEN` (builds, `vercel env pull`). |
| `Credentials.fromChain()`      | `fromEnv`, then `fromVercelOidc`. Same order as Vercel's own SDK.                                                                                                          |

Each request carries `x-api-key` and `ai-gateway-auth-method` (`api-key` or `oidc`). A
missing credential fails the request with an `AiError` wrapping a `CredentialsError` that
names the source it tried and how to fix it.

Environment variables are read through Effect's `Config`, so a `ConfigProvider` can redirect
them. The OIDC token is not refreshed when it expires locally; re-run `vercel env pull`.

## Dialect fixes

Two adjustments are applied to traffic with the gateway:

- Requests: `"cache_control": null` is removed from content blocks. The Effect provider emits it,
  Anthropic accepts it, the gateway rejects it.
- Responses: keys Anthropic always sends but the gateway omits are filled in with Anthropic's
  "nothing to report" values, so the provider's schemas decode. These are the cache and
  service-tier usage fields, `signature` on thinking blocks from non-Anthropic models, and
  `type`/`request_id` on error envelopes (unknown `error.type` values map to `api_error`).

Streaming responses pass through untouched.

## Development

```sh
pnpm install
pnpm test
pnpm check   # tsc
pnpm lint    # oxlint
pnpm fmt     # oxfmt
pnpm build   # tsdown -> dist/
```

## License

MIT
