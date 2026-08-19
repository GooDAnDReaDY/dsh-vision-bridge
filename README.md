# dsh-vision-bridge

**Vision bridge** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a self-contained replacement for `dsh-vision-router`.

When the chat model has **no vision** (e.g. `deepseek-v4-flash`) and a message contains an image, the image never reaches the text-only model. Instead, the plugin substitutes an **automatic text description from the vision model you choose** (Hermes-style). The text model just reads text and keeps the conversation going; the image stays in the session log and in the UI.

- **`describe_image`** — a tool for when you need more precise details on an image (ask a model).
- **Description cache** by `contentHash` of the bytes — an image is described once, then the previous description is reused on later turns.
- **You pick the vision model** in **Settings → Vision** (a top-level settings section alongside General / Models / Plugins).

## Install

```bash
# From npm after publishing:
dsh plugin --profile web add @goodandready/dsh-vision-bridge

# From GitHub:
dsh plugin --profile web add github:GooDAnDReaDY/dsh-vision-bridge
# Locally from a checkout:
dsh plugin --profile web add /path/to/dsh-vision-bridge
```

Restart the Web UI, open **Settings → Vision**, pick a provider and model (or leave empty — auto-picks the first vision-capable model).

## Replacing `dsh-vision-router`

This does the same job but under your control and with your own vision model. If `dsh-vision-router` is installed, remove it:

```sh
dsh plugin --profile web remove dsh-vision-router
```

## How it works (Hermes-style)

1. An image (from you or from a tool like `generate_image`) enters the chat and is shown by the UI.
2. **On every LLM request**, at two points:
   - `agent/pre-step`, which sees the messages claimed from the inbox — that is, the images **you** attach. Rewriting them here puts the description into the session history, so the model still remembers the image on later turns.
   - `llm/stream`, which sees the **whole outgoing request**. This is the net under everything else: a tool result is appended straight to the session and never passes through `pre-step`, so an image a tool produced (`generate_image`, for one) would otherwise reach the adapter untouched and fail the turn with `does not support image input`.
3. At either point the rule is the same:
   - if the chat model is vision-capable (`inputModalities` includes `image`) — images go through as-is;
   - if the model is text-only — for each image block:
     - already cached description (by `attachmentId` or content hash) → reuse it;
     - otherwise **automatically** call the vision model via `ctx.llm.stream`, get a description, cache it, and inject it as `[The user attached an image. Here is what it contains: ...]`.
3. The text model reads text, not pixels. Turns never fail with `UNSUPPORTED_CONTENT`.
4. **`describe_image`** stays available for when you need more precise details on an image (ask a model directly).

## Settings

**Settings → Vision** (top-level section):

- **Provider** — the vision model's provider (from the LLM catalog).
- **Model** — the model (only vision-capable ones are shown).
- Empty → auto-pick the first vision model.

In `settings.yaml`:

```yaml
dsh-vision-bridge:
  visionProvider: ""   # empty = auto-pick
  visionModel: ""      # empty = auto-pick
  sanitizeImages: true
  maxImageBytes: 20971520
  timeoutMs: 120000
```

## Structure

```
dsh-vision-bridge/
├── package.json            # dsh bundle/plugin metadata + peerDependencies
├── cordis.patch.yml        # bundle layer: inserts the plugin row
├── lib/index.js            # host: agent/pre-step sanitizer + describe_image + cache + model list
├── lib/client.js           # browser: top-level Settings → Vision section
├── README.md
└── LICENSE                 # MIT
```

## License

MIT
