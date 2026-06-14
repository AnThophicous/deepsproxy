/*
 * File: playwright.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let currentHeaders: Record<string, string> = {};
let lastRuntimeError: string | null = null;

const SESSION_CACHE_PATH = path.resolve('.deepsproxy', 'deepseek-session.json');

interface DeepSeekSessionSnapshot {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: number | null;
  capturedAt: string;
}

export interface DeepSeekRuntimeHealth {
  object: 'deepsproxy.upstream';
  provider: 'deepseek';
  status: 'ready' | 'not_checked' | 'not_initialized' | 'needs_login' | 'suspended' | 'unavailable';
  checked_at: string;
  browser: {
    initialized: boolean;
    active_page: boolean;
    page_origin: string | null;
    title: string | null;
  };
  accounts: Array<{
    id: string;
    label: string;
    status: DeepSeekRuntimeHealth['status'];
    healthy: boolean;
    authorization_captured: boolean;
    input_available: boolean;
    last_error: string | null;
  }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyRuntimeError(message: string): DeepSeekRuntimeHealth['status'] {
  if (/No cached DeepSeek session/i.test(message)) return 'needs_login';
  if (/account is suspended|suspended until|violation of user policies/i.test(message)) return 'suspended';
  if (/login is required|log in|sign in/i.test(message)) return 'needs_login';
  if (/not initialized|browser|playwright/i.test(message)) return 'not_initialized';
  return 'unavailable';
}

function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function isUsableSession(snapshot: DeepSeekSessionSnapshot | null): snapshot is DeepSeekSessionSnapshot {
  return Boolean(snapshot?.headers?.authorization);
}

function loadCachedSession(): DeepSeekSessionSnapshot | null {
  try {
    if (!existsSync(SESSION_CACHE_PATH)) return null;
    const parsed = JSON.parse(readFileSync(SESSION_CACHE_PATH, 'utf8')) as DeepSeekSessionSnapshot;
    if (!isUsableSession(parsed)) return null;
    currentHeaders = parsed.headers;
    return parsed;
  } catch {
    return null;
  }
}

function saveCachedSession(snapshot: DeepSeekSessionSnapshot): void {
  mkdirSync(path.dirname(SESSION_CACHE_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_CACHE_PATH, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  chmodSync(SESSION_CACHE_PATH, 0o600);
}

export async function initPlaywright(headless = true) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = path.resolve('deepseek_profile');

  try {
    context = await chromium.launchPersistentContext(profilePath, {
      headless,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--exclude-switches=enable-automation',
        '--disable-infobars',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    // Keep an active page to fetch PoW headers on demand
    activePage = await context.newPage();
    lastRuntimeError = null;
  } catch (error) {
    context = null;
    activePage = null;
    lastRuntimeError = errorMessage(error);
    throw error;
  }
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    await context.close();
    context = null;
    activePage = null;
  }
}

export async function getDeepSeekRuntimeHealth(options: { probe?: boolean } = {}): Promise<DeepSeekRuntimeHealth> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return {
      object: 'deepsproxy.upstream',
      provider: 'deepseek',
      status: 'ready',
      checked_at: new Date().toISOString(),
      browser: {
        initialized: true,
        active_page: true,
        page_origin: 'mock',
        title: 'mock',
      },
      accounts: [{
        id: 'default',
        label: 'deepseek_profile',
        status: 'ready',
        healthy: true,
        authorization_captured: true,
        input_available: true,
        last_error: null,
      }],
    };
  }

  const cached = loadCachedSession();

  if (options.probe && envFlag('DEEPSPROXY_ALLOW_RUNTIME_BROWSER', false)) {
    try {
      const probe = await getDeepSeekHeaders(false);
      const ready = Boolean(probe.headers.authorization);
      return {
        object: 'deepsproxy.upstream',
        provider: 'deepseek',
        status: ready ? 'ready' : 'unavailable',
        checked_at: new Date().toISOString(),
        browser: {
          initialized: Boolean(context),
          active_page: Boolean(activePage),
          page_origin: activePage ? new URL(activePage.url()).origin : null,
          title: activePage ? await activePage.title().catch(() => null) : null,
        },
        accounts: [{
          id: 'default',
          label: 'deepseek_profile',
          status: ready ? 'ready' : 'unavailable',
          healthy: ready,
          authorization_captured: ready,
          input_available: true,
          last_error: ready ? null : 'DeepSeek authorization header was not captured.',
        }],
      };
    } catch (error) {
      const message = errorMessage(error);
      const status = classifyRuntimeError(message);
      return {
        object: 'deepsproxy.upstream',
        provider: 'deepseek',
        status,
        checked_at: new Date().toISOString(),
        browser: {
          initialized: Boolean(context),
          active_page: Boolean(activePage),
          page_origin: activePage ? new URL(activePage.url()).origin : null,
          title: activePage ? await activePage.title().catch(() => null) : null,
        },
        accounts: [{
          id: 'default',
          label: 'deepseek_profile',
          status,
          healthy: false,
          authorization_captured: Boolean(currentHeaders.authorization),
          input_available: false,
          last_error: message,
        }],
      };
    }
  }

  let pageState: any = null;
  if (activePage) {
    pageState = await activePage.evaluate(() => {
      const fullBodyText = document.body?.innerText || '';
      return {
        origin: location.origin,
        title: document.title || null,
        inputAvailable: document.querySelectorAll('textarea, [role="textbox"], [contenteditable="true"]').length > 0,
        suspended: /suspended until|violation of user policies|account has been suspended/i.test(fullBodyText),
        loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
      };
    }).catch(() => null);
  }

  const authCaptured = Boolean(currentHeaders.authorization || cached?.headers.authorization);
  let status: DeepSeekRuntimeHealth['status'] = 'not_checked';
  if (authCaptured) status = 'ready';
  else if (!context || !activePage) status = 'needs_login';
  else if (pageState?.suspended) status = 'suspended';
  else if (pageState?.loginRequired) status = 'needs_login';
  else if (pageState?.inputAvailable) status = 'not_checked';
  else if (lastRuntimeError) status = classifyRuntimeError(lastRuntimeError);

  return {
    object: 'deepsproxy.upstream',
    provider: 'deepseek',
    status,
    checked_at: new Date().toISOString(),
    browser: {
      initialized: Boolean(context),
      active_page: Boolean(activePage),
      page_origin: pageState?.origin ?? (activePage ? new URL(activePage.url()).origin : null),
      title: pageState?.title ?? null,
    },
    accounts: [{
      id: 'default',
      label: 'deepseek_profile',
      status,
      healthy: status === 'ready',
      authorization_captured: authCaptured,
      input_available: Boolean(pageState?.inputAvailable),
      last_error: lastRuntimeError,
    }],
  };
}

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 */
export async function getDeepSeekHeaders(
  forceNew = false,
  options: { allowBrowser?: boolean } = {}
): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: number | null }> {
  try {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      // Generate a unique session ID if requested for testing isolation
      const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
      return { headers: { authorization: 'Bearer MOCK' }, chatSessionId: mockSessionId, parentMessageId: null };
    }

    if (!forceNew) {
      const cached = loadCachedSession();
      if (cached) {
        return {
          headers: cached.headers,
          chatSessionId: cached.chatSessionId,
          parentMessageId: cached.parentMessageId,
        };
      }
    }

    const browserAllowed = options.allowBrowser || envFlag('DEEPSPROXY_ALLOW_RUNTIME_BROWSER', false);
    if (!browserAllowed) {
      throw new Error('No cached DeepSeek session is available. Run npm run login to capture a browser session, or set DEEPSPROXY_ALLOW_RUNTIME_BROWSER=true to allow runtime browser fallback.');
    }

    if (!activePage) {
      await initPlaywright();
    }

    if (!activePage) {
      throw new Error('Playwright not initialized');
    }

  // Navigate to deepseek chat. If forceNew is true or we're not on deepseek, go to home page.
  const currentUrl = activePage.url();
  const isOnDeepSeek = currentUrl.includes('chat.deepseek.com');
  const isOnSpecificChat = isOnDeepSeek && /\/chat\/\d+/.test(currentUrl);

  if (!isOnDeepSeek || forceNew || isOnSpecificChat) {
    await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  }

  // Wait for the chat input. Keep this timeout short: when DeepSeek shows an
  // account/login/suspension banner there is no input, and retrying the same
  // browser state just makes OpenAI clients look hung.
  const chatInputSelector = 'textarea, [role="textbox"], [contenteditable="true"]';
  const chatInputTimeoutMs = Number(process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS || '8000');
  await activePage.waitForSelector(chatInputSelector, { timeout: chatInputTimeoutMs }).catch(async () => {
    const pageState = await activePage!.evaluate(() => {
      const fullBodyText = document.body?.innerText || '';
      const bodyText = fullBodyText.slice(0, 5000);
      const suspensionMatch = fullBodyText.match(/Due to violation of user policies, your account has been suspended until\s+([^\.\n]+)\.\s*If you have any questions, please Contact us\./i);
      const suspendedUntil = suspensionMatch?.[1]?.trim() || null;
      const suspensionOriginal = suspensionMatch?.[0]?.trim() || null;
      return {
        url: location.href,
        title: document.title,
        bodyText,
        textareaCount: document.querySelectorAll('textarea').length,
        inputCount: document.querySelectorAll('input, textarea, [role="textbox"], [contenteditable]').length,
        suspended: /suspended until|violation of user policies|account has been suspended/i.test(fullBodyText),
        suspendedUntil,
        suspensionOriginal,
        loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
      };
    }).catch((e: any) => ({ evaluateError: e?.message || String(e) }));

    const state: any = pageState;
    if (state?.suspended) {
      const until = typeof state.suspendedUntil === 'string' && state.suspendedUntil.trim() ? state.suspendedUntil.trim() : '';
      const original = typeof state.suspensionOriginal === 'string' && state.suspensionOriginal.trim() ? state.suspensionOriginal.trim() : '';
      const detail = original || (until ? `Due to violation of user policies, your account has been suspended until ${until}.` : 'DeepSeek reported an account suspension.');
      throw new Error(`DeepSeek account is suspended; chat input is unavailable. Original DeepSeek message: ${detail}`);
    }
    if (state?.loginRequired) {
      throw new Error('DeepSeek login is required; chat input is unavailable.');
    }
    throw new Error('DeepSeek chat input unavailable; page did not expose an input box.');
  });

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for PoW headers')), 30000);

    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);
      
      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: number | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const payload = JSON.parse(postData);
          if (payload.chat_session_id) {
            uiSessionId = payload.chat_session_id;
          }
          if (payload.parent_message_id !== undefined) {
            uiParentMessageId = payload.parent_message_id;
          }
        } catch (e) {
          // ignore parsing error
        }
      }

      const extractedHeaders = {
        'x-ds-pow-response': reqHeaders['x-ds-pow-response'] || '',
        'x-hif-dliq': reqHeaders['x-hif-dliq'] || '',
        'x-hif-leim': reqHeaders['x-hif-leim'] || '',
        'authorization': reqHeaders['authorization'] || '',
        'cookie': reqHeaders['cookie'] || ''
      };

      currentHeaders = extractedHeaders;
      saveCachedSession({
        headers: extractedHeaders,
        chatSessionId: uiSessionId,
        parentMessageId: uiParentMessageId,
        capturedAt: new Date().toISOString(),
      });

      // Abort to prevent polluting chat history
      await route.abort('aborted');
      
      // Cleanup route
      await activePage!.unroute('**/api/v0/chat/completion', routeHandler);

      lastRuntimeError = null;
      resolve({ headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId });
    };

    activePage!.route('**/api/v0/chat/completion', routeHandler).then(() => {
      // Trigger PoW generation by typing and hitting enter
      activePage!.fill('textarea', 'a').then(() => {
        activePage!.keyboard.press('Enter');
      });
    });
    });
  } catch (error) {
    lastRuntimeError = errorMessage(error);
    throw error;
  }
}
