# effect-vercel

[Effect](https://effect.website) (v4) integrations for Vercel. Each one is its own entry point:

| Import                     | What                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `effect-vercel/ai-gateway` | [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) for Effect AI |
| `effect-vercel/oidc`       | The OIDC token Vercel issues to a deployment                          |

## Install

```sh
pnpm add effect-vercel effect
pnpm add @effect/ai-anthropic   # only for effect-vercel/ai-gateway
```

## AI Gateway

The gateway serves the Anthropic Messages API and routes to any model it lists, named
`provider/model`. `AiGateway` points Effect AI's Anthropic provider at the gateway, handles
authentication per request, and smooths over the small differences between the gateway's
dialect and what the provider's schemas expect.

### Usage

```ts
import { AiGateway } from "effect-vercel/ai-gateway"
import { AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"

const Model = AnthropicLanguageModel.layer({ model: "google/gemini-2.5-flash" }).pipe(
  Layer.provide(AiGateway.layer),
  Layer.provide(FetchHttpClient.layer),
)

const program = LanguageModel.generateText({ prompt: "Say hi" }).pipe(
  Effect.map((r) => r.text),
  Effect.provide(Model),
)
```

`AiGateway.layer` provides `AnthropicClient` and requires an `HttpClient`. It authenticates
with `AI_GATEWAY_API_KEY` if set, else the Vercel OIDC token, the same order as Vercel's own
SDK. So it works locally with an API key and on Vercel with no setup.

Any Effect AI feature that works with the Anthropic provider (tools, structured output,
streaming, thinking) works through the gateway, for every model the gateway offers.

### Credentials

To pick the source yourself, use `AiGateway.layerWithoutCredentials` and provide an
`AiGatewayCredentials` layer:

```ts
AnthropicLanguageModel.layer({ model: "google/gemini-2.5-flash" }).pipe(
  Layer.provide(AiGateway.layerWithoutCredentials),
  Layer.provide([AiGatewayCredentials.layerFromApiKey(key), FetchHttpClient.layer]),
)
```

| Layer                                       | Source                                                    |
| ------------------------------------------- | --------------------------------------------------------- |
| `AiGatewayCredentials.layer`                | The default: `layerFromEnv`, then `layerFromVercelOidc`.  |
| `AiGatewayCredentials.layerFromEnv`         | `AI_GATEWAY_API_KEY`. Local dev, CI, anywhere off Vercel. |
| `AiGatewayCredentials.layerFromVercelOidc`  | The Vercel OIDC token (see [OIDC](#oidc)).                |
| `AiGatewayCredentials.layerFromApiKey(key)` | A fixed key. Tests, custom wiring.                        |

The credential is resolved on every request, so a rotating token is always current.
Each request carries `x-api-key` and `ai-gateway-auth-method` (`api-key` or `oidc`). A
missing credential fails the request with an `AiError` wrapping an `AiGatewayCredentialsError` that
names the source it tried and how to fix it.

Environment variables are read through Effect's `Config`, so a `ConfigProvider` can redirect
them.

### Dialect fixes

Two adjustments are applied to traffic with the gateway:

- Requests: `"cache_control": null` is removed from content blocks. The Effect provider emits it,
  Anthropic accepts it, the gateway rejects it.
- Responses: keys Anthropic always sends but the gateway omits are filled in with Anthropic's
  "nothing to report" values, so the provider's schemas decode. These are the cache and
  service-tier usage fields, `signature` on thinking blocks from non-Anthropic models, and
  `type`/`request_id` on error envelopes (unknown `error.type` values map to `api_error`).

Streaming responses pass through untouched.

## OIDC

Vercel issues each deployment an OIDC token. Use it for the AI Gateway, or exchange it for
cloud credentials (AWS `AssumeRoleWithWebIdentity`, GCP workload identity federation).

```ts
import { VercelOidc } from "effect-vercel/oidc"
import { Effect, Redacted } from "effect"

const program = Effect.gen(function* () {
  const token = yield* VercelOidc.token
  // Redacted.value(token) is the web identity token
})
```

- `VercelOidc.token` reads the `x-vercel-oidc-token` header of the current request
  (Functions), else `VERCEL_OIDC_TOKEN` (builds, `vercel env pull`). It fails with a
  `VercelOidcError` when neither is set.
- `VercelOidc.find` is the same but returns `Option.none()` instead of failing, for fallback
  chains.

Both read the token on every run, since it rotates per request. They do not refresh an
expired local token; re-run `vercel env pull`.

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
