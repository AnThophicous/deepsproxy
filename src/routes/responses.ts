import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

type DispatchChat = (body: Record<string, unknown>, c: Context) => Promise<Response>;

interface StoredResponse {
  response: Record<string, unknown>;
  conversation: Array<Record<string, unknown>>;
  expiresAt: number;
  createdAt: number;
}

const responseStore = new Map<string, StoredResponse>();

function responseStorePath() {
  return path.resolve(process.env.DEEPSPROXY_RESPONSES_STORE_PATH || '.deepsproxy/responses-store.json');
}

function responseTtlMs() {
  return Number(process.env.DEEPSPROXY_RESPONSES_TTL_MS || String(7 * 24 * 60 * 60 * 1000));
}

function responseMaxEntries() {
  return Number(process.env.DEEPSPROXY_RESPONSES_MAX_ENTRIES || '1000');
}

function loadResponsesFromDisk() {
  try {
    const storePath = responseStorePath();
    if (!existsSync(storePath)) return;
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    responseStore.clear();
    for (const entry of entries) {
      if (!entry?.id || !entry?.value?.response || !Array.isArray(entry?.value?.conversation)) continue;
      responseStore.set(String(entry.id), entry.value as StoredResponse);
    }
  } catch (error) {
    console.warn(`[responses] Failed to load response store: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function persistResponsesToDisk() {
  try {
    const storePath = responseStorePath();
    mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const payload = {
      version: 1,
      saved_at: new Date().toISOString(),
      entries: Array.from(responseStore.entries()).map(([id, value]) => ({ id, value })),
    };
    const tmpPath = `${storePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(tmpPath, storePath);
    chmodSync(storePath, 0o600);
  } catch (error) {
    console.warn(`[responses] Failed to persist response store: ${error instanceof Error ? error.message : String(error)}`);
  }
}

loadResponsesFromDisk();

export function __clearResponseStoreForTests() {
  responseStore.clear();
}

function compactId(prefix: string): string {
  return `${prefix}_${uuidv4().replaceAll('-', '')}`;
}

function pruneResponses() {
  const now = Date.now();
  for (const [id, entry] of responseStore) {
    if (entry.expiresAt <= now) responseStore.delete(id);
  }

  const maxEntries = responseMaxEntries();
  if (responseStore.size > maxEntries) {
    const sorted = Array.from(responseStore.entries())
      .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
    for (const [id] of sorted.slice(0, responseStore.size - maxEntries)) {
      responseStore.delete(id);
    }
  }

  persistResponsesToDisk();
}

function refreshResponseStore() {
  loadResponsesFromDisk();
  pruneResponses();
}

function setStoredResponse(id: string, entry: Omit<StoredResponse, 'createdAt' | 'expiresAt'> & Partial<Pick<StoredResponse, 'createdAt' | 'expiresAt'>>) {
  const createdAt = entry.createdAt ?? Date.now();
  responseStore.set(id, {
    ...entry,
    createdAt,
    expiresAt: entry.expiresAt ?? createdAt + responseTtlMs(),
  });
  pruneResponses();
}

function errorEnvelope(message: string, status = 400, code = 'invalid_request_error') {
  return {
    status,
    body: {
      error: {
        message,
        type: status === 404 ? 'not_found_error' : code,
        param: null,
        code,
      },
    },
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return String(part ?? '');
        const record = part as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.image_url === 'string') return `[Image: ${record.image_url}]`;
        if (record.image_url && typeof record.image_url === 'object') {
          const url = (record.image_url as Record<string, unknown>).url;
          return typeof url === 'string' ? `[Image: ${url}]` : '[Image]';
        }
        return JSON.stringify(record);
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function responseInputToMessages(input: unknown): Array<Record<string, unknown>> {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];

  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (record.type === 'message' || typeof record.role === 'string') {
      return [{
        role: String(record.role || 'user'),
        content: contentToText(record.content),
      }];
    }
    if (record.type === 'function_call_output') {
      return [{
        role: 'tool',
        tool_call_id: String(record.call_id || ''),
        content: contentToText(record.output),
      }];
    }
    return [];
  });
}

function responseToolsToChat(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => {
    const record = tool as Record<string, unknown>;
    if (record.type === 'function' && typeof record.name === 'string') {
      return {
        type: 'function',
        function: {
          name: record.name,
          description: record.description,
          parameters: record.parameters,
          strict: record.strict,
        },
      };
    }
    return tool;
  });
}

function responseToolChoiceToChat(choice: unknown): unknown {
  if (!choice || typeof choice === 'string') return choice;
  const record = choice as Record<string, unknown>;
  if (record.type === 'function' && typeof record.name === 'string') {
    return { type: 'function', function: { name: record.name } };
  }
  return choice;
}

function toChatBody(body: Record<string, unknown>, previousMessages: Array<Record<string, unknown>>) {
  const inputMessages = responseInputToMessages(body.input);
  const instructions = typeof body.instructions === 'string' && body.instructions
    ? [{ role: 'system', content: body.instructions }]
    : [];
  return {
    model: body.model,
    messages: [...instructions, ...previousMessages, ...inputMessages],
    stream: Boolean(body.stream),
    tools: responseToolsToChat(body.tools),
    tool_choice: responseToolChoiceToChat(body.tool_choice),
    parallel_tool_calls: body.parallel_tool_calls,
    prompt_cache_key: body.prompt_cache_key,
    prompt_cache_retention: body.prompt_cache_retention,
    metadata: body.metadata,
  };
}

function responseUsage(chatUsage: any) {
  if (!chatUsage) return null;
  return {
    input_tokens: chatUsage.prompt_tokens ?? 0,
    input_tokens_details: {
      cached_tokens: chatUsage.prompt_tokens_details?.cached_tokens ?? 0,
    },
    output_tokens: chatUsage.completion_tokens ?? 0,
    output_tokens_details: {
      reasoning_tokens: chatUsage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    total_tokens: chatUsage.total_tokens ?? 0,
  };
}

function outputText(output: Array<Record<string, unknown>>): string {
  let text = '';
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
        text += (part as Record<string, unknown>).text;
      }
    }
  }
  return text;
}

function responseObject(
  id: string,
  body: Record<string, unknown>,
  output: Array<Record<string, unknown>>,
  status: string,
  usage: unknown,
  error: unknown = null,
) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: body.model,
    output,
    output_text: outputText(output),
    error,
    incomplete_details: status === 'completed' ? null : error,
    instructions: body.instructions ?? null,
    previous_response_id: body.previous_response_id ?? null,
    store: body.store ?? true,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    prompt_cache_key: body.prompt_cache_key ?? null,
    prompt_cache_retention: body.prompt_cache_retention ?? null,
    tools: body.tools ?? [],
    tool_choice: body.tool_choice ?? 'auto',
    usage,
    metadata: body.metadata ?? {},
  };
}

function assistantMessageFromOutput(output: Array<Record<string, unknown>>): Record<string, unknown> | null {
  let content = '';
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          content += (part as Record<string, unknown>).text;
        }
      }
    }

    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments ?? '{}',
        },
      });
    }
  }

  if (!content && toolCalls.length === 0) return null;

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: toolCalls.length > 0 ? null : content,
  };
  if (content && toolCalls.length > 0) message.content = content;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

function conversationAfterTurn(
  previousMessages: Array<Record<string, unknown>>,
  input: unknown,
  output: Array<Record<string, unknown>>,
) {
  const assistant = assistantMessageFromOutput(output);
  return [
    ...previousMessages,
    ...responseInputToMessages(input),
    ...(assistant ? [assistant] : []),
  ];
}

function outputFromChat(chat: any): Array<Record<string, unknown>> {
  const message = chat.choices?.[0]?.message ?? {};
  const output: Array<Record<string, unknown>> = [];
  if (typeof message.content === 'string' && message.content) {
    output.push({
      id: compactId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }
  for (const call of message.tool_calls || []) {
    output.push({
      id: compactId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments ?? '{}',
    });
  }
  return output;
}

async function parseChatSse(
  source: ReadableStream<Uint8Array>,
  onChunk: (chunk: any) => Promise<void>,
) {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          await onChunk(JSON.parse(data));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createResponsesHandler(dispatchChat: DispatchChat) {
  return async function handleResponses(c: Context) {
    refreshResponseStore();
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      const error = errorEnvelope('The request body is not valid JSON.', 400, 'invalid_json');
      return c.json(error.body, error.status as any);
    }

    if (typeof body.model !== 'string' || !body.model) {
      const error = errorEnvelope("'model' is required.", 400, 'missing_required_parameter');
      return c.json(error.body, error.status as any);
    }

    let previousMessages: Array<Record<string, unknown>> = [];
    if (typeof body.previous_response_id === 'string') {
      const previous = responseStore.get(body.previous_response_id);
      if (!previous) {
        const error = errorEnvelope(`Response '${body.previous_response_id}' was not found.`, 404, 'response_not_found');
        return c.json(error.body, error.status as any);
      }
      previousMessages = previous.conversation;
    }

    const responseId = compactId('resp');
    const chatBody = toChatBody(body, previousMessages);

    if (!body.stream) {
      const chatResponse = await dispatchChat(chatBody, c);
      const chatJson: any = await chatResponse.json().catch(() => null);
      if (!chatResponse.ok) return c.json(chatJson, chatResponse.status as any);

      const output = outputFromChat(chatJson);
      const response = responseObject(responseId, body, output, 'completed', responseUsage(chatJson.usage));
      if (body.store !== false) setStoredResponse(responseId, {
        response,
        conversation: conversationAfterTurn(previousMessages, body.input, output),
      });
      return c.json(response);
    }

    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (writer: any) => {
      let sequence = 0;
      let text = '';
      let messageStarted = false;
      const messageId = compactId('msg');
      const output: Array<Record<string, unknown>> = [];
      const toolCalls = new Map<number, any>();

      const emit = async (type: string, payload: Record<string, unknown>) => {
        const event = {
          event_id: compactId('evt'),
          response_id: responseId,
          ...payload,
          type,
          sequence_number: sequence++,
        };
        await writer.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      const started = responseObject(responseId, body, [], 'in_progress', null);
      await emit('response.created', { response: started });
      await emit('response.in_progress', { response: started });

      const ensureMessage = async () => {
        if (messageStarted) return;
        messageStarted = true;
        const item = { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
        output.push(item);
        await emit('response.output_item.added', { output_index: 0, item });
        await emit('response.content_part.added', {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      };

      try {
        const chatResponse = await dispatchChat(chatBody, c);
        if (!chatResponse.ok || !chatResponse.body) {
          const err = await chatResponse.json().catch(() => ({ error: { message: 'Chat adapter failed.' } }));
          const detail = err.error ?? err;
          await emit('error', detail);
          await emit('response.failed', {
            response: responseObject(responseId, body, output, 'failed', null, detail),
          });
          return;
        }

        await parseChatSse(chatResponse.body, async (chunk) => {
          const choice = chunk.choices?.[0];
          const delta = choice?.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) {
            await ensureMessage();
            text += delta.content;
            await emit('response.output_text.delta', {
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: delta.content,
            });
          }
          for (const toolCall of delta.tool_calls || []) {
            const index = Number(toolCall.index ?? 0);
            if (!toolCalls.has(index)) {
              const itemId = compactId('fc');
              const item = {
                id: itemId,
                type: 'function_call',
                status: 'in_progress',
                call_id: toolCall.id || compactId('call'),
                name: toolCall.function?.name || '',
                arguments: '',
              };
              toolCalls.set(index, item);
              output.push(item);
              await emit('response.output_item.added', { output_index: output.length - 1, item });
            }
            const item = toolCalls.get(index);
            const args = toolCall.function?.arguments || '';
            item.arguments += args;
            await emit('response.function_call_arguments.delta', {
              item_id: item.id,
              output_index: output.indexOf(item),
              delta: args,
            });
          }
        });

        if (messageStarted) {
          const part = { type: 'output_text', text, annotations: [] };
          output[0] = { id: messageId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
          await emit('response.output_text.done', { item_id: messageId, output_index: 0, content_index: 0, text });
          await emit('response.content_part.done', { item_id: messageId, output_index: 0, content_index: 0, part });
          await emit('response.output_item.done', { output_index: 0, item: output[0] });
        }

        for (const item of toolCalls.values()) {
          item.status = 'completed';
          await emit('response.function_call_arguments.done', {
            item_id: item.id,
            output_index: output.indexOf(item),
            arguments: item.arguments,
          });
          await emit('response.output_item.done', { output_index: output.indexOf(item), item });
        }

        const completed = responseObject(responseId, body, output, 'completed', null);
        if (body.store !== false) setStoredResponse(responseId, {
          response: completed,
          conversation: conversationAfterTurn(previousMessages, body.input, output),
        });
        await emit('response.completed', { response: completed });
      } catch (error) {
        const detail = {
          message: error instanceof Error ? error.message : String(error),
          type: 'api_error',
          code: 'upstream_error',
        };
        await emit('error', detail);
        await emit('response.failed', {
          response: responseObject(responseId, body, output, 'failed', null, detail),
        });
        if (body.store !== false) setStoredResponse(responseId, {
          response: responseObject(responseId, body, output, 'failed', null, detail),
          conversation: [
            ...previousMessages,
            ...responseInputToMessages(body.input),
          ],
        });
      }
    });
  };
}

export function retrieveResponse(c: Context) {
  refreshResponseStore();
  const id = c.req.param('response_id') || '';
  const stored = responseStore.get(id);
  if (!stored) {
    const error = errorEnvelope(`Response '${id}' was not found.`, 404, 'response_not_found');
    return c.json(error.body, error.status as any);
  }
  return c.json(stored.response);
}

export function cancelResponse(c: Context) {
  const id = c.req.param('response_id');
  return c.json({
    id,
    object: 'response',
    status: 'cancelled',
  });
}
