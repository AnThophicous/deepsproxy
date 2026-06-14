/*
 * File: deepseek.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { getDeepSeekHeaders } from './playwright.ts';
import { createDeepSeekPowResponse } from './pow.ts';

// In-memory state to track the last message ID per session to avoid overwriting
// Use globalThis to ensure it survives module reloads in some test environments
const sessionStates: Record<string, number | null> = (globalThis as any)._sessionStates || {};
(globalThis as any)._sessionStates = sessionStates;

export function updateSessionParent(sessionId: string, parentId: number | null) {
  if (sessionId) {
    sessionStates[sessionId] = parentId;
  }
}

export interface DeepSeekPayload {
  chat_session_id?: string;
  parent_message_id?: number | null;
  model_type: string | null;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  preempt: boolean;
}

async function validateDeepSeekStream(response: Response): Promise<ReadableStream> {
  if (!response.body) {
    throw new Error('DeepSeek response did not include a stream body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    const first = await reader.read();
    if (first.done) {
      throw new Error('DeepSeek returned an empty response body.');
    }

    const firstText = decoder.decode(first.value, { stream: true });
    const trimmed = firstText.trimStart();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        const code = parsed?.code ?? parsed?.error?.code ?? 'unknown';
        const message = parsed?.msg ?? parsed?.message ?? parsed?.error?.message ?? 'Unknown DeepSeek error.';
        if (code === 40301 || /INVALID_POW_RESPONSE/i.test(String(message))) {
          throw new Error(`DeepSeek rejected the generated proof-of-work response (${message}). The local PoW solver may be stale, or the cached session headers from npm run login may need to be refreshed.`);
        }
        throw new Error(`DeepSeek returned an API error (${code}): ${message}`);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`DeepSeek returned non-SSE JSON that could not be parsed: ${trimmed.slice(0, 200)}`);
        }
        throw error;
      }
    }

    return new ReadableStream({
      async start(controller) {
        controller.enqueue(first.value);
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              break;
            }
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        reader.releaseLock();
      },
    });
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
}

export async function createDeepSeekStream(
  prompt: string,
  enableThinking: boolean,
  isProModel: boolean = false,
  forcedParentId?: number | null
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string }> {
  // Runtime should use the cached session captured by `npm run login`.
  // `forcedParentId` controls only conversation continuity, not browser startup.
  const { headers, chatSessionId, parentMessageId } = await getDeepSeekHeaders(false);

  // Determine the actual parent ID:
  // 1. If forcedParentId is provided (even if null), use it.
  // 2. If tracked parent ID is available for this session, use it.
  // 3. Fallback to Playwright's state.
  let actualParentId: number | null = parentMessageId;
  
  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
  } else if (chatSessionId && sessionStates[chatSessionId] !== undefined) {
    actualParentId = sessionStates[chatSessionId];
  }

  const payload: DeepSeekPayload = {
    chat_session_id: chatSessionId || undefined,
    parent_message_id: actualParentId,
    model_type: isProModel ? 'expert' : null,
    prompt: prompt,
    ref_file_ids: [],
    thinking_enabled: enableThinking,
    search_enabled: true,
    preempt: false
  };

  let powResponse = headers['x-ds-pow-response'] || '';
  if (!process.env.TEST_MOCK_PLAYWRIGHT) {
    powResponse = await createDeepSeekPowResponse({
      scene: 'completion_like',
      targetPath: '/api/v0/chat/completion',
      sessionHeaders: headers,
    });
  }

  const response = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'authorization': headers['authorization'],
      'content-type': 'application/json',
      'origin': 'https://chat.deepseek.com',
      'x-ds-pow-response': powResponse,
      'x-hif-dliq': headers['x-hif-dliq'],
      'x-hif-leim': headers['x-hif-leim'],
      'x-app-version': '2.0.0',
      'x-client-locale': 'pt_BR',
      'x-client-platform': 'web',
      'x-client-version': '2.0.0'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Failed to fetch from DeepSeek: ${response.status} ${response.statusText} - ${errText}`);
  }

  const stream = await validateDeepSeekStream(response);
  return { stream, headers, uiSessionId: chatSessionId };
}
