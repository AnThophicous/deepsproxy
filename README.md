# DeepsProxy

DeepsProxy e uma proxy local compativel com rotas OpenAI que usa uma sessao logada do DeepSeek Web por baixo. A ideia e simples: fazer clientes como Zed, Codex CLI, OpenCode e ferramentas OpenAI-compatible chamarem `http://127.0.0.1:3000/v1` sem precisar falar direto com a API oficial do DeepSeek.

> Projeto para uso educacional e pesquisa. Respeite os termos de uso dos servicos que voce conectar.

## O Que Ela Faz

- Rotas OpenAI-compatible: `/v1/chat/completions`, `/v1/responses`, `/v1/models` e `/v1/models/:model`.
- Aliases sem `/v1` para clientes que chamam `/chat/completions` ou `/responses`.
- Streaming SSE no formato esperado por clientes OpenAI-compatible.
- Tool calling em formato OpenAI, com suporte a `parallel_tool_calls`.
- Aceita `prompt_cache_key` e `prompt_cache_retention` sem quebrar clientes como Zed.
- Login via Playwright, com runtime usando cache em `.deepsproxy/deepseek-session.json`.
- Health check com estado da proxy, rotas e conta DeepSeek.
- `npm install` baixa somente o Chromium necessario do Playwright.
- `npm run update` atualiza o repo sem apagar sessao nem `node_modules` manualmente.

## Instalar

```bash
git clone https://github.com/AnThophicous/deepsproxy.git
cd deepsproxy
npm install
```

O `npm install` ja instala o Chromium usado pelo Playwright. Para pular esse download:

```bash
DEEPSPROXY_SKIP_BROWSER_INSTALL=1 npm install
```

## Login

```bash
npm run login
```

Faça login no DeepSeek na janela aberta. Quando o chat estiver disponível, a DeepsProxy captura a sessão e salva um cache local em `.deepsproxy/deepseek-session.json`. Depois disso, o servidor pode rodar sem manter Playwright aberto.

## Rodar

```bash
npm start
```

Ao iniciar, o console mostra a porta e as rotas disponiveis. Cada request tambem aparece no log com metodo, path, status e tempo. O servidor não abre Playwright no startup.

Por padrao a porta e `3000`:

```text
http://127.0.0.1:3000/v1
```

## Configuracao

Crie um `.env` se quiser mudar defaults:

```env
PORT=3000
API_KEY=
PLAYWRIGHT_HEADLESS=true
DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS=8000
DEEPSPROXY_DISABLE_TOOL_PROMPT=false
DEEPSPROXY_RESPONSES_STORE_PATH=.deepsproxy/responses-store.json
DEEPSPROXY_RESPONSES_TTL_MS=604800000
DEEPSPROXY_RESPONSES_MAX_ENTRIES=1000
DEEPSPROXY_ALLOW_RUNTIME_BROWSER=false
```

`API_KEY` e opcional. Se definido, clientes precisam enviar `Authorization: Bearer <API_KEY>` ou `X-API-Key: <API_KEY>`.

Use `DEEPSPROXY_DISABLE_TOOL_PROMPT=true` quando o cliente ja envia o proprio system prompt e as proprias tools. Isso evita que a proxy injete instrucoes extras de ferramenta por cima do prompt do Zed, Codex ou outro agente.

`DEEPSPROXY_RESPONSES_STORE_PATH`, `DEEPSPROXY_RESPONSES_TTL_MS` e `DEEPSPROXY_RESPONSES_MAX_ENTRIES` controlam o estado local da Responses API. Esse arquivo guarda o historico necessario para `previous_response_id`, entao ele pode conter prompts e tool outputs. Por padrao fica dentro de `.deepsproxy/`, que ja e ignorado pelo Git.

Use `DEEPSPROXY_ALLOW_RUNTIME_BROWSER=true` apenas se quiser o comportamento antigo de permitir que requests abram Playwright como fallback. O fluxo recomendado e rodar `npm run login` quando a sessão expirar.

## Modelos Aceitos

IDs principais:

- `deepseek-v4-flash`
- `deepseek-v4-flash-thinking`
- `deepseek-v4-pro`
- `deepseek-v4-pro-thinking`

Aliases aceitos:

- `deepseek-flash`
- `deepseek-flash-thinking`
- `deepseek-thinking`
- `deepseek-pro`
- `deepseek-pro-thinking`
- `deepseek-chat`
- `deepseek-reasoner`

Modelos fora dessa lista retornam erro OpenAI-compatible `model_not_found`. Isso evita casos em que um cliente tenta usar `gpt-5-mini`, `MiniMax-M3` ou outro ID que a DeepsProxy nao serve.

## Zed

No Zed, adicione um provider OpenAI-compatible apontando para a proxy:

```json
{
  "language_models": {
    "openai_compatible": {
      "deepsproxy": {
        "api_url": "http://127.0.0.1:3000/v1",
        "available_models": [
          {
            "name": "deepseek-v4-flash-thinking",
            "display_name": "DeepSeek V4 Flash Thinking",
            "max_tokens": 64000,
            "max_output_tokens": 8000,
            "capabilities": {
              "tools": true,
              "images": false,
              "parallel_tool_calls": true,
              "prompt_cache_key": true,
              "chat_completions": true
            }
          }
        ]
      }
    }
  }
}
```

Se `API_KEY` estiver vazio na proxy, qualquer chave no provider do Zed serve. Se `API_KEY` estiver definido, use a mesma chave no Zed.

## Codex CLI

Adicione ao `~/.codex/config.toml`:

```toml
model = "deepseek-v4-flash-thinking"
model_provider = "deepsproxy"

[model_providers.deepsproxy]
name = "DeepsProxy"
base_url = "http://127.0.0.1:3000/v1"
wire_api = "responses"
env_key = "DEEPSPROXY_API_KEY"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
```

Se voce definiu `API_KEY` no `.env`, exporte a mesma chave antes de abrir o Codex:

```bash
export DEEPSPROXY_API_KEY="sua-chave"
```

Se `API_KEY` estiver vazio, pode usar qualquer valor local:

```bash
export DEEPSPROXY_API_KEY="sk-local"
```

## Responses API E Continuidade

`/v1/responses` retorna IDs no formato `resp_...` e aceita `previous_response_id`. Isso permite que clientes como Codex mantenham estado entre turnos sem reenviar toda a conversa manualmente.

Quando `store` nao e `false`, a proxy salva localmente:

- mensagens de usuario;
- resposta final do assistente;
- chamadas de ferramenta com `call_id`;
- outputs de ferramentas enviados no turno seguinte.

Na proxima request com `previous_response_id`, a DeepsProxy reconstrói o contexto no formato interno usado pelo DeepSeek Web e preserva a ordem `system/instructions -> historico -> input atual`. O estado tambem sobrevive a restart do servidor porque e persistido em `.deepsproxy/responses-store.json`.

Limite importante: isso replica a semantica de continuidade da OpenAI para o cliente, mas o DeepSeek Web nao oferece um storage server-side igual ao da OpenAI. Entao a economia real de tokens depende do upstream; a DeepsProxy garante compatibilidade de protocolo e historico, nao uma reducao magica de contexto no DeepSeek.

## Health Check

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/v1/health
```

Para forcar uma checagem ativa da sessao DeepSeek:

```bash
curl "http://127.0.0.1:3000/health?probe=1"
```

A resposta mostra:

- `status`: estado geral da proxy.
- `server.routes`: rotas expostas.
- `upstream.accounts`: estado da conta DeepSeek (`ready`, `needs_login`, `suspended`, `not_initialized`, `not_checked` ou `unavailable`).
- `authorization_captured`: se a proxy ja conseguiu capturar header de autenticacao da sessao.

## Rotas

```text
GET  /health
GET  /v1/health
GET  /v1/models
GET  /v1/models/:model
POST /v1/chat/completions
POST /v1/responses
GET  /v1/responses/:response_id
POST /v1/responses/:response_id/cancel
POST /chat/completions
POST /responses
```

## Atualizar

```bash
npm run update
```

O updater:

- busca commits novos do remote atual;
- aplica update somente se for fast-forward;
- nao apaga `deepseek_profile/`;
- preserva a sessao logada;
- roda `npm install` para atualizar dependencias;
- roda `npm run build` no final.

Se existirem alteracoes locais em arquivos rastreados, ele para antes de mexer no repo.

## Docker

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

Monte `deepseek_profile/` como volume para manter a sessao entre reinicios.

## Troubleshooting

`model_not_found`: o cliente enviou um modelo que nao esta na lista aceita. Configure Zed/Codex para usar `deepseek-v4-flash-thinking` ou outro ID listado acima.

`endpoint_not_found`: o cliente chamou uma rota que a proxy nao expoe. Use `http://127.0.0.1:3000/v1` como base URL.

`deepseek_login_required`: rode `npm run login` novamente.

`deepseek_account_suspended`: a pagina do DeepSeek indicou suspensao da conta. A proxy nao apaga a sessao automaticamente sem certeza.

`upstream_error`: a proxy conseguiu receber a request, mas o DeepSeek falhou ou nao retornou stream valido.
