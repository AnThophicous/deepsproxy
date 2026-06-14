import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './index.ts';
import { initPlaywright, closePlaywright } from './services/playwright.ts';
import { __clearResponseStoreForTests } from './routes/responses.ts';

test('Health check endpoint returns DeepsProxy health envelope', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.strictEqual(body.object, 'deepsproxy.health');
  assert.strictEqual(body.server.status, 'ok');
  assert.ok(Array.isArray(body.server.routes));
  assert.strictEqual(body.upstream.object, 'deepsproxy.upstream');
  assert.ok(Array.isArray(body.upstream.accounts));
});

test('Models endpoint returns deepseek-v4-flash and deepseek-v4-flash-thinking', async () => {
  const req = new Request('http://localhost/v1/models');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.strictEqual(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash'));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash-thinking'));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-flash-thinking'));
  const flash = body.data.find((m: any) => m.id === 'deepseek-v4-flash');
  assert.strictEqual(typeof flash.context_length, 'number');
  assert.ok(flash.context_length > 0);
  assert.strictEqual(typeof flash.max_context_tokens, 'number');
});

test('Chat Completions rejects unknown model IDs', async () => {
  const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'ping' }],
    }),
  }));

  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.error.code, 'model_not_found');
});

test('Root OpenAI-compatible aliases are available', async () => {
  const missingBody = {
    model: 'missing-model',
    messages: [{ role: 'user', content: 'ping' }],
  };
  const chat = await app.fetch(new Request('http://localhost/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(missingBody),
  }));
  assert.strictEqual(chat.status, 404);
  assert.strictEqual((await chat.json()).error.code, 'model_not_found');
});

test('Chat Completions endpoint with deepseek-v4-flash-thinking (thinking enabled)', { skip: process.env.RUN_DEEPSEEK_INTEGRATION_TESTS !== 'true' }, async () => {
  // Initialize playwright for this test
  // NOTE: Headless mode can sometimes fail Cloudflare checks. We use headless=false for the test
  // to ensure it matches the logged-in browser state if needed, or you can switch it to true.
  await initPlaywright(false);

  try {
    const payload = {
      model: 'deepseek-v4-flash-thinking',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);
              
              if (data.choices && data.choices[0] && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.content) {
                hasContent = true;
              }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch (err) {
            // Partial JSON ignored
            // console.error("Parse error:", err);
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    await closePlaywright();
  }
});

test('Model retrieval returns OpenAI-shaped model or 404', async () => {
  const existing = await app.fetch(new Request('http://localhost/v1/models/deepseek-chat'));
  assert.strictEqual(existing.status, 200);
  assert.strictEqual((await existing.json()).id, 'deepseek-chat');

  const missing = await app.fetch(new Request('http://localhost/v1/models/missing-model'));
  assert.strictEqual(missing.status, 404);
  assert.strictEqual((await missing.json()).error.code, 'model_not_found');
});

test('Responses endpoint is available for OpenAI-compatible clients', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
    if (url.includes('chat.deepseek.com')) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"pong"}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }
    return originalFetch(input, init);
  };
  process.env.TEST_MOCK_PLAYWRIGHT = 'true';

  try {
    const res = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        input: 'ping',
        parallel_tool_calls: true,
        prompt_cache_key: 'zed-test',
      }),
    }));
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.object, 'response');
    assert.strictEqual(body.status, 'completed');
    assert.strictEqual(body.prompt_cache_key, 'zed-test');
    assert.strictEqual(body.parallel_tool_calls, true);
    assert.strictEqual(body.output[0].content[0].text, 'pong');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MOCK_PLAYWRIGHT;
  }
});

test('Responses streaming emits response.failed when the chat adapter rejects the model', async () => {
  const res = await app.fetch(new Request('http://localhost/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      input: 'ping',
      stream: true,
    }),
  }));

  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('Content-Type') || '', /^text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes('event: error'), 'stream must expose an error event');
  assert.ok(text.includes('event: response.failed'), 'stream must terminate with response.failed');
  assert.ok(text.includes('model_not_found'), 'stream must preserve the model error code');
});

test('Responses previous_response_id reloads persisted conversation state', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'deepsproxy-responses-'));
  const previousStorePath = process.env.DEEPSPROXY_RESPONSES_STORE_PATH;
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];

  process.env.DEEPSPROXY_RESPONSES_STORE_PATH = path.join(tmp, 'responses-store.json');
  process.env.TEST_MOCK_PLAYWRIGHT = 'true';
  __clearResponseStoreForTests();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
    if (url.includes('chat.deepseek.com')) {
      const payload = JSON.parse(String(init?.body || '{}'));
      prompts.push(payload.prompt);
      const text = prompts.length === 1 ? 'stored alpha' : 'second answer';
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: {"p":"response/content","v":"${text}"}\n\n`));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }
    return originalFetch(input, init);
  };

  try {
    const first = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        input: 'Remember alpha',
        store: true,
      }),
    }));
    assert.strictEqual(first.status, 200);
    const firstBody = await first.json();
    assert.match(firstBody.id, /^resp_/);

    __clearResponseStoreForTests();

    const second = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        input: 'What did I ask you to remember?',
        previous_response_id: firstBody.id,
        store: true,
      }),
    }));
    assert.strictEqual(second.status, 200);
    const secondBody = await second.json();
    assert.strictEqual(secondBody.previous_response_id, firstBody.id);
    assert.ok(prompts[1].includes('User: Remember alpha'), 'previous user input must be replayed');
    assert.ok(prompts[1].includes('Assistant: stored alpha'), 'previous assistant output must be replayed');
    assert.ok(prompts[1].includes('User: What did I ask you to remember?'), 'current input must be appended');
  } finally {
    globalThis.fetch = originalFetch;
    __clearResponseStoreForTests();
    if (previousStorePath === undefined) delete process.env.DEEPSPROXY_RESPONSES_STORE_PATH;
    else process.env.DEEPSPROXY_RESPONSES_STORE_PATH = previousStorePath;
    delete process.env.TEST_MOCK_PLAYWRIGHT;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Responses previous_response_id preserves tool call and tool output history', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'deepsproxy-responses-tools-'));
  const previousStorePath = process.env.DEEPSPROXY_RESPONSES_STORE_PATH;
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];

  process.env.DEEPSPROXY_RESPONSES_STORE_PATH = path.join(tmp, 'responses-store.json');
  process.env.TEST_MOCK_PLAYWRIGHT = 'true';
  __clearResponseStoreForTests();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
    if (url.includes('chat.deepseek.com')) {
      const payload = JSON.parse(String(init?.body || '{}'));
      prompts.push(payload.prompt);
      const chunk = prompts.length === 1
        ? 'data: {"p":"response/content","v":"<tool_call name=\\"read_file\\"><parameter name=\\"file_path\\">/workspace/index.html</parameter></tool_call>"}\n\n'
        : 'data: {"p":"response/content","v":"tool result accepted"}\n\n';
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chunk));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }
    return originalFetch(input, init);
  };

  try {
    const first = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        input: 'Read index',
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } }],
        store: true,
      }),
    }));
    assert.strictEqual(first.status, 200);
    const firstBody = await first.json();
    const call = firstBody.output.find((item: any) => item.type === 'function_call');
    assert.ok(call);
    assert.strictEqual(call.name, 'read_file');

    __clearResponseStoreForTests();

    const second = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        previous_response_id: firstBody.id,
        input: [
          {
            type: 'function_call_output',
            call_id: call.call_id,
            output: '<html>barber</html>',
          },
        ],
        store: true,
      }),
    }));
    assert.strictEqual(second.status, 200);
    assert.ok(prompts[1].includes('<tool_call>{"name": "read_file"'), 'previous assistant tool call must be replayed');
    assert.ok(prompts[1].includes('Tool Response'), 'tool output must be replayed');
    assert.ok(prompts[1].includes('<html>barber</html>'), 'tool output content must be included');
  } finally {
    globalThis.fetch = originalFetch;
    __clearResponseStoreForTests();
    if (previousStorePath === undefined) delete process.env.DEEPSPROXY_RESPONSES_STORE_PATH;
    else process.env.DEEPSPROXY_RESPONSES_STORE_PATH = previousStorePath;
    delete process.env.TEST_MOCK_PLAYWRIGHT;
    rmSync(tmp, { recursive: true, force: true });
  }
});
