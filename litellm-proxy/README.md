# LiteLLM Proxy

Run a local LiteLLM proxy to use any LLM provider (Anthropic, Gemini, Mistral, Ollama, etc.) with p[0].

## Setup

Run with Docker:

```bash
docker run -d \
  --name litellm \
  -p 4000:4000 \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e GEMINI_API_KEY=... \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml --port 4000
```

## Configure

Edit `config.yaml` to add your models. Pass the required API keys as `-e` flags to the `docker run` command.

## Connect to p[0]

In the root `.env` file:

```
LLM_BASE_URL=http://localhost:4000/v1
LLM_MODEL=claude-sonnet-4-5-20250929  # or any model_name from config.yaml
LLM_API_KEY=sk-litellm-master-key     # matches master_key in config.yaml
```

## Docs

- [LiteLLM Docker Quick Start](https://docs.litellm.ai/docs/proxy/docker_quick_start)
- [LiteLLM Supported Providers](https://docs.litellm.ai/docs/providers)
