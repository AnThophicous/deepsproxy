/*
 * File: index.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatCompletions } from './routes/chat.ts';
import { cancelResponse, createResponsesHandler, retrieveResponse } from './routes/responses.ts';
import * as dotenv from 'dotenv';
import { getDeepSeekRuntimeHealth } from './services/playwright.ts';
import { listAcceptedModelIds, modelEntry, modelNotFoundError } from './services/models.ts';

dotenv.config();

export const app = new Hono();

app.use('*', cors());

app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${new URL(c.req.url).pathname}:`, err);
  return c.json({
    error: {
      message: err.message || 'Unexpected server error.',
      type: 'api_error',
      param: null,
      code: 'internal_error',
    },
  }, 500);
});

app.use('*', async (c, next) => {
  const started = Date.now();
  const path = new URL(c.req.url).pathname;
  console.log(`[request] ${c.req.method} ${path}`);
  await next();
  console.log(`[response] ${c.req.method} ${path} ${c.res.status} ${Date.now() - started}ms`);
});

app.use('*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('Authorization');
    const xApiKey = c.req.header('X-API-Key');
    const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;
    if (!providedKey || providedKey !== apiKey) {
      return c.json({
        error: {
          message: 'Incorrect API key provided.',
          type: 'authentication_error',
          param: null,
          code: 'invalid_api_key',
        },
      }, 401);
    }
  }
  await next();
});

async function healthResponse(c: any) {
  const probe = ['1', 'true', 'yes'].includes(String(c.req.query('probe') || '').toLowerCase());
  const upstream = await getDeepSeekRuntimeHealth({ probe });
  const routes = [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/v1/health' },
    { method: 'GET', path: '/v1/models' },
    { method: 'GET', path: '/v1/models/:model' },
    { method: 'POST', path: '/v1/chat/completions' },
    { method: 'POST', path: '/v1/responses' },
    { method: 'GET', path: '/v1/responses/:response_id' },
    { method: 'POST', path: '/v1/responses/:response_id/cancel' },
    { method: 'POST', path: '/chat/completions', alias_for: '/v1/chat/completions' },
    { method: 'POST', path: '/responses', alias_for: '/v1/responses' },
  ];

  return c.json({
    object: 'deepsproxy.health',
    status: upstream.status === 'ready' ? 'ok' : 'degraded',
    server: {
      status: 'ok',
      routes,
    },
    upstream,
  });
}

app.get('/health', healthResponse);
app.get('/v1/health', healthResponse);

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);
app.post('/chat/completions', chatCompletions);
app.post('/v1/responses', createResponsesHandler(async (body, c) => {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const authorization = c.req.header('Authorization');
  const xApiKey = c.req.header('X-API-Key');
  if (authorization) headers.set('Authorization', authorization);
  else if (process.env.API_KEY) headers.set('Authorization', `Bearer ${process.env.API_KEY}`);
  if (xApiKey) headers.set('X-API-Key', xApiKey);
  return app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }));
}));
app.post('/responses', createResponsesHandler(async (body, c) => {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const authorization = c.req.header('Authorization');
  const xApiKey = c.req.header('X-API-Key');
  if (authorization) headers.set('Authorization', authorization);
  else if (process.env.API_KEY) headers.set('Authorization', `Bearer ${process.env.API_KEY}`);
  if (xApiKey) headers.set('X-API-Key', xApiKey);
  return app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }));
}));
app.get('/v1/responses/:response_id', retrieveResponse);
app.post('/v1/responses/:response_id/cancel', cancelResponse);

app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: listAcceptedModelIds().map((id) => modelEntry(id)).filter(Boolean),
  });
});

app.get('/v1/models/:model', (c) => {
  const model = c.req.param('model');
  const entry = modelEntry(model);
  if (!entry) return c.json(modelNotFoundError(model), 404);
  return c.json(entry);
});

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  return c.json({
    error: {
      message: `Endpoint not found: ${c.req.method} ${path}`,
      type: 'invalid_request_error',
      param: null,
      code: 'endpoint_not_found',
    },
  }, 404);
});

import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  serve({
    fetch: app.fetch,
    port
  });
  console.log(`DeepsProxy server running on port ${port}`);
  console.log('Available routes:');
  console.log('  GET  /health');
  console.log('  GET  /v1/health');
  console.log('  GET  /v1/models');
  console.log('  GET  /v1/models/:model');
  console.log('  POST /v1/chat/completions');
  console.log('  POST /v1/responses');
  console.log('  GET  /v1/responses/:response_id');
  console.log('  POST /v1/responses/:response_id/cancel');
  console.log('  POST /chat/completions (alias)');
  console.log('  POST /responses (alias)');
  console.log('Browser runtime is disabled by default. Run npm run login to refresh the cached DeepSeek session.');
}
