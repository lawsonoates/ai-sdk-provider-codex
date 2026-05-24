**Note**: this code was written by AI.

# ai-sdk-provider-codex

Use your ChatGPT Plus/Pro subscription auth with the official OpenAI AI SDK [provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai).

The auth logic is derived from OpenCode's [codex plugin](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/codex.ts).

This repo does NOT authenticate against the Codex backend; login with Codex first to create the token file.

## Usage

Authenticate with Codex first, then create an AI SDK fetch:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { createFetch } from "ai-sdk-provider-codex";

const openai = createOpenAI({
  apiKey: "codex-oauth-dummy-key",
  fetch: createFetch(),
});

const model = openai.responses("gpt-5.5");
```

By default, `createFetch()` reads `~/.codex/auth.json`. You can pass another Codex auth file:

```ts
const openai = createOpenAI({
  apiKey: "codex-oauth-dummy-key",
  fetch: createFetch({
    tokenPath: "~/.codex/auth.json",
  }),
});
```

## License

MIT
