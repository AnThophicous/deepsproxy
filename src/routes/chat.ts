/*
 * File: chat.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { OpenAIRequest, ChoiceDelta, Message, ToolCall, Usage } from '../utils/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { getModelTelemetry, recordSuccess, recordFailure } from '../services/telemetry.ts';
import { compressMessages } from '../utils/compression.ts';
import { modelNotFoundError, resolveModel } from '../services/models.ts';

const TOOL_START = '<tool_call>';
const TOOL_END = '</tool_call>';
const TOOL_OPEN_RE = /<tool_call\b[^>]*>/i;

type EmitChunk = (data: any) => Promise<void>;

interface ParsedCompletion {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
}

function messageContentToString(content: any): string {
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
  }
  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return content || '';
}

function serializeOpenAIMessages(messages: Message[]) {
  let prompt = '';
  let systemPrompt = '';

  for (const msg of messages) {
    const contentStr = messageContentToString(msg.content);

    if (msg.role === 'system') {
      systemPrompt += contentStr + '\n\n';
      continue;
    }

    if (msg.role === 'user') {
      prompt += `User: ${contentStr}\n\n`;
      continue;
    }

    if (msg.role === 'assistant') {
      let assistantContent = contentStr;
      if ((msg as any).reasoning_content) {
        assistantContent = `<think>\n${(msg as any).reasoning_content}\n</think>\n${assistantContent}`;
      }
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let args = tc.function?.arguments || '{}';
          if (typeof args !== 'string') args = JSON.stringify(args);
          assistantContent += `\n<tool_call>{"name": "${tc.function?.name}", "arguments": ${args}}</tool_call>`;
        }
      }
      prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      continue;
    }

    if (msg.role === 'tool' || msg.role === 'function') {
      prompt += `Tool Response (${msg.name || msg.tool_call_id || 'tool'}): ${contentStr}\n\n`;
      continue;
    }

    prompt += `${msg.role}: ${contentStr}\n\n`;
  }

  return { prompt, systemPrompt };
}

function appendToolInstructions(systemPrompt: string, body: OpenAIRequest): string {
  const bodyAny = body as any;
  if (!bodyAny.tools || !Array.isArray(bodyAny.tools) || bodyAny.tools.length === 0) {
    return systemPrompt;
  }
  if (bodyAny.tool_choice === 'none') {
    return systemPrompt;
  }
  const disableToolPrompt = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.DEEPSPROXY_DISABLE_TOOL_PROMPT || '').toLowerCase()
  );
  if (disableToolPrompt) {
    return systemPrompt;
  }

  const formattedTools = bodyAny.tools.map((t: any) => {
    if (t.type === 'function') {
      return {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters
      };
    }
    return t;
  });
  const toolsJson = JSON.stringify(formattedTools, null, 2);

  const parallelRule = bodyAny.parallel_tool_calls === false
    ? 'Call at most one tool in this response.'
    : 'You may call multiple tools by outputting multiple <tool_call> blocks consecutively.';

  systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nRULES:\n1. ${parallelRule}\n2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.\n3. The JSON must be valid and accurately follow the tool's parameters.\n4. Never put prose inside <tool_call>. Never use XML <parameter> tags. Always include the exact tool name in the JSON "name" field.\n\n`;

  if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
    const forcedTool = bodyAny.tool_choice.function.name;
    systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
  }

  return systemPrompt;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function coerceParameterValue(rawValue: string): unknown {
  const value = decodeXmlEntities(rawValue.trim());
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch {}
  }
  return value;
}

function extractToolName(openTag: string, block: string): string {
  const combined = `${openTag}\n${block}`;
  const attrMatch = combined.match(/<tool_call\b[^>]*\bname\s*=\s*["']([^"']+)["']/i);
  if (attrMatch) return attrMatch[1];

  const nameTagMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameTagMatch) return decodeXmlEntities(nameTagMatch[1].trim());

  const functionTagMatch = block.match(/<(?:function|tool|tool_name|function_name)>([\s\S]*?)<\/(?:function|tool|tool_name|function_name)>/i);
  if (functionTagMatch) return decodeXmlEntities(functionTagMatch[1].trim());

  return '';
}

interface ToolDescriptor {
  name: string;
  description: string;
  properties: Record<string, any>;
  required: string[];
}

function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function getToolFunction(tool: any): any {
  if (tool?.type === 'function' && tool.function) return tool.function;
  if (tool?.function && typeof tool.function === 'object') return tool.function;
  return tool;
}

function getToolDescriptors(tools: any[]): ToolDescriptor[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool: any) => {
    const fn = getToolFunction(tool);
    if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) return [];
    const parameters = fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : {};
    const properties = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
    const required = Array.isArray(parameters.required) ? parameters.required.filter((v: unknown): v is string => typeof v === 'string') : [];
    return [{
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      properties,
      required,
    }];
  });
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveDeclaredToolName(name: string, tools: any[]): string {
  if (!name) return '';
  const descriptors = getToolDescriptors(tools);
  if (descriptors.length === 0) return name;

  const exact = descriptors.find(d => d.name === name);
  if (exact) return exact.name;

  const normalized = normalizeToolName(name);
  const normalizedMatch = descriptors.find(d => normalizeToolName(d.name) === normalized);
  return normalizedMatch?.name || '';
}

function inferToolNameFromParameters(args: Record<string, unknown>, tools: any[]): string {
  const argKeys = Object.keys(args);
  if (argKeys.length === 0) return '';

  const matches = getToolDescriptors(tools).filter((tool) => {
    const properties = tool.properties || {};
    return argKeys.every(k => Object.prototype.hasOwnProperty.call(properties, k));
  });

  if (matches.length === 1) {
    return matches[0].name;
  }

  return '';
}

function parseArgumentsCandidate(candidate: unknown): Record<string, unknown> {
  if (!candidate) return {};
  if (typeof candidate === 'string') {
    try {
      const parsed = robustParseJSON(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
    return {};
  }
  if (typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }
  return {};
}

function normalizeParsedToolCall(parsed: any, openTag: string, block: string, tools: any[]): any | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const attrToolName = extractToolName(openTag, block);
  const descriptors = getToolDescriptors(tools);

  if (!attrToolName) {
    const topLevelKeys = Object.keys(parsed);
    if (topLevelKeys.length === 1) {
      const declared = resolveDeclaredToolName(topLevelKeys[0], tools);
      if (declared) {
        return { name: declared, arguments: parseArgumentsCandidate(parsed[topLevelKeys[0]]) };
      }
    }
  }

  let toolName = attrToolName;
  let args: Record<string, unknown> = {};

  if (parsed.function && typeof parsed.function === 'object' && !Array.isArray(parsed.function)) {
    const fn = parsed.function as Record<string, unknown>;
    if (!toolName && typeof fn.name === 'string') toolName = fn.name;
    args = parseArgumentsCandidate(fn.arguments ?? fn.parameters ?? fn.args);
  }

  if (!toolName) {
    for (const key of ['name', 'tool', 'tool_name', 'function_name', 'function']) {
      if (typeof parsed[key] === 'string') {
        toolName = parsed[key];
        break;
      }
    }
  }

  if (Object.keys(args).length === 0) {
    args = parseArgumentsCandidate(parsed.arguments ?? parsed.args ?? parsed.parameters ?? parsed.params ?? parsed.input);
  }

  if (Object.keys(args).length === 0) {
    const reserved = new Set(['name', 'tool', 'tool_name', 'function_name', 'function', 'arguments', 'args', 'parameters', 'params', 'input']);
    for (const [key, value] of Object.entries(parsed)) {
      if (!reserved.has(key)) args[key] = value;
    }
  }

  if (!toolName) {
    toolName = inferToolNameFromParameters(args, tools);
  }

  const declared = resolveDeclaredToolName(toolName, tools);
  if (descriptors.length > 0 && !declared) return null;
  toolName = declared || toolName;

  if (!toolName) return null;
  return { name: toolName, arguments: args };
}

function cleanInferredValue(value: string): string {
  return decodeXmlEntities(value)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+(?:directory|folder)(?:['’]s)?(?:\s+contents?)?$/i, '')
    .replace(/[.;:,]+$/g, '')
    .trim();
}

function firstQuotedText(text: string): string {
  const match = text.match(/["'`]([^"'`\n]+)["'`]/);
  return match ? cleanInferredValue(match[1]) : '';
}

function pickStringParam(tool: ToolDescriptor, preferred: string[]): string {
  const lowerPreferred = preferred.map(p => p.toLowerCase());
  const propEntries = Object.entries(tool.properties || {});
  for (const preferredName of lowerPreferred) {
    const found = propEntries.find(([key]) => key.toLowerCase() === preferredName);
    if (found) return found[0];
  }

  const requiredString = tool.required.find((key) => {
    const schema = tool.properties?.[key];
    return !schema || schema.type === 'string' || Array.isArray(schema.type) && schema.type.includes('string');
  });
  if (requiredString) return requiredString;

  const onlyString = propEntries.filter(([, schema]) => !schema || schema.type === 'string' || Array.isArray(schema.type) && schema.type.includes('string'));
  if (onlyString.length === 1) return onlyString[0][0];

  return tool.required[0] || propEntries[0]?.[0] || '';
}

function inferDirectoryPath(text: string): string {
  const quoted = firstQuotedText(text);
  if (quoted) return quoted;

  const patterns = [
    /\blist(?:\s+the)?\s+(.+?)\s+(?:directory|folder)(?:['’]s)?(?:\s+contents?)?/i,
    /\b(?:directory|folder)\s+(?:called|named)?\s*([^.\n,;]+)/i,
    /\bcontents?\s+of\s+(?:the\s+)?(.+?)(?:\s+(?:directory|folder))?(?:[.\n,;]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanInferredValue(match[1]);
  }

  return '';
}

function inferFilePath(text: string): string {
  const quoted = firstQuotedText(text);
  if (quoted) return quoted;

  const patterns = [
    /\bread(?:\s+the)?\s+(?:file\s+)?([^.\n,;]+)/i,
    /\bopen(?:\s+the)?\s+(?:file\s+)?([^.\n,;]+)/i,
    /\bfile\s+([^.\n,;]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanInferredValue(match[1]);
  }

  return '';
}

function descriptorMatchesIntent(tool: ToolDescriptor, intent: 'list_directory' | 'read_file' | 'search'): boolean {
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  if (intent === 'list_directory') {
    return /(?:list|ls|show)/i.test(haystack) && /(?:director|folder|dir|files?)/i.test(haystack);
  }
  if (intent === 'read_file') {
    return /(?:read|open|view|cat)/i.test(haystack) && /file/i.test(haystack);
  }
  return /(?:search|grep|find|ripgrep|rg)/i.test(haystack);
}

function inferToolCallFromNaturalText(block: string, tools: any[]): any | null {
  if (!envFlag('DEEPSPROXY_ENABLE_NATURAL_TOOL_INFERENCE', false)) return null;

  const descriptors = getToolDescriptors(tools);
  if (descriptors.length === 0) return null;

  const text = decodeXmlEntities(sanitizeToolArtifacts(block).replace(/<[^>]+>/g, ' ')).trim();
  if (!text) return null;

  const mentioned = descriptors.filter((tool) => {
    const lower = text.toLowerCase();
    return lower.includes(tool.name.toLowerCase()) || lower.includes(tool.name.replace(/[_:-]+/g, ' ').toLowerCase());
  });

  let tool: ToolDescriptor | undefined = mentioned.length === 1 ? mentioned[0] : undefined;
  const lower = text.toLowerCase();
  let intent: 'list_directory' | 'read_file' | 'search' | null = null;

  if (!tool && /\b(?:list|show|inspect|explore|see)\b/.test(lower) && /\b(?:directory|folder|dir|contents?|files?)\b/.test(lower)) {
    intent = 'list_directory';
  } else if (!tool && /\b(?:read|open|view)\b/.test(lower) && /\bfile\b/.test(lower)) {
    intent = 'read_file';
  } else if (!tool && /\b(?:search|grep|find)\b/.test(lower)) {
    intent = 'search';
  }

  if (!tool && intent) {
    const intentMatches = descriptors.filter(d => descriptorMatchesIntent(d, intent!));
    if (intentMatches.length === 1) tool = intentMatches[0];
  }

  if (!tool) return null;

  const args: Record<string, unknown> = {};
  if (intent === 'list_directory' || descriptorMatchesIntent(tool, 'list_directory')) {
    const param = pickStringParam(tool, ['path', 'directory', 'dir', 'directory_path', 'folder', 'folder_path']);
    if (param) args[param] = inferDirectoryPath(text) || '.';
  } else if (intent === 'read_file' || descriptorMatchesIntent(tool, 'read_file')) {
    const param = pickStringParam(tool, ['file_path', 'path', 'file', 'filename']);
    const value = inferFilePath(text);
    if (param && value) args[param] = value;
  } else if (intent === 'search' || descriptorMatchesIntent(tool, 'search')) {
    const param = pickStringParam(tool, ['query', 'pattern', 'search', 'term']);
    const value = firstQuotedText(text) || text;
    if (param && value) args[param] = value;
  }

  const missingRequired = tool.required.filter(key => args[key] === undefined);
  if (missingRequired.length > 0) return null;
  return { name: tool.name, arguments: args };
}

function missingRequiredToolArgs(toolName: string, args: Record<string, unknown>, tools: any[]): string[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const descriptor = getToolDescriptors(tools).find(tool => tool.name === toolName);
  if (!descriptor) return [];

  return descriptor.required.filter((key) => {
    const value = args[key];
    return value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);
  });
}

function parseXmlParameterToolCall(block: string, openTag: string, tools: any[]): any | null {
  const args: Record<string, unknown> = {};
  const parameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = parameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
  }

  if (Object.keys(args).length === 0 && /<parameter\b/i.test(block)) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

function parseToolCallBlock(block: string, openTag: string, tools: any[]): any {
  const parsedXml = parseXmlParameterToolCall(block, openTag, tools);
  if (parsedXml) return parsedXml;

  const parsedJson = robustParseJSON(block);
  if (!parsedJson) throw new Error('Empty tool call');

  const normalized = normalizeParsedToolCall(parsedJson, openTag, block, tools);
  if (!normalized) throw new Error('Tool call missing or unknown name');

  return normalized;
}

function declaredToolNames(tools: any[]): Set<string> {
  return new Set(getToolDescriptors(tools).map(tool => tool.name));
}

function parsePlainTextToolCalls(text: string, tools: any[]): Array<{ name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(tools) || tools.length === 0) return [];

  const names = declaredToolNames(tools);
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const searchable = text.split(/\n\s*Tool Response\s*:/i)[0] || text;
  const toolCallRe = /(?:^|\n)\s*Tool\s*:\s*([A-Za-z0-9_.:-]+)\s*\n\s*Arguments\s*:\s*([\s\S]*?)(?=\n\s*Tool\s*:|\n\s*Tool Response\s*:|\n\s*Assistant\s*:|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = toolCallRe.exec(searchable)) !== null) {
    const name = match[1]?.trim();
    const rawArgs = match[2]?.trim() || '{}';
    if (!name || !names.has(name)) continue;

    const parsedArgs = robustParseJSON(rawArgs);
    if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) continue;
    const args = parsedArgs as Record<string, unknown>;
    if (missingRequiredToolArgs(name, args, tools).length > 0) continue;
    calls.push({ name, arguments: args });
  }

  return calls;
}

function sanitizeToolArtifacts(text: string): string {
  return text
    .replace(/(?:^|\n)\s*Tool\s*:\s*[A-Za-z0-9_.:-]+\s*\n\s*Arguments\s*:[\s\S]*?(?=\n\s*(?:Tool\s*:|Tool Response\s*:|Assistant\s*:)|$)/gi, '\n')
    .replace(/(?:^|\n)\s*Tool Response\s*:[\s\S]*$/gi, '')
    .replace(/<tool_call\b[^>]*>/gi, '')
    .replace(/<\/tool_call>/gi, '')
    .replace(/<parameter\b[^>]*>/gi, '')
    .replace(/<\/parameter>/gi, '');
}

function warnToolParser(message: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[chat] ${message}: ${detail}`);
}

function findToolOpen(buffer: string): { startIdx: number; endIdx: number; openTag: string } | null {
  const match = buffer.match(TOOL_OPEN_RE);
  if (!match || match.index === undefined) return null;
  return {
    startIdx: match.index,
    endIdx: match.index + match[0].length,
    openTag: match[0]
  };
}

function findPartialToolOpenIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  const idx = lower.lastIndexOf('<tool_call');
  if (idx !== -1 && lower.indexOf('>', idx) === -1) return idx;

  for (let i = 1; i < TOOL_START.length; i++) {
    if (lower.endsWith(TOOL_START.substring(0, i))) return buffer.length - i;
  }
  return -1;
}

function makeChoice(delta: any, finishReason: string | null = null) {
  return {
    index: 0,
    delta,
    logprobs: null,
    finish_reason: finishReason
  };
}

function makeChunk(completionId: string, model: string, delta: any, finishReason: string | null = null, usage?: Usage) {
  const chunk: any = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeChoice(delta, finishReason)]
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

function isSessionInvalidError(message: string): boolean {
  return /INVALID_POW_RESPONSE|proof-of-work|cached session proof/i.test(message);
}

async function parseDeepSeekStreamToOpenAI(
  deepSeekStream: ReadableStream,
  completionId: string,
  model: string,
  promptTokens: number,
  uiSessionId: string,
  tools: any[] = [],
  emit?: EmitChunk
): Promise<ParsedCompletion> {
  const reader = deepSeekStream.getReader();
  const decoder = new TextDecoder();

  let currentAppendPath = '';
  let currentFragmentType = '';
  let reasoningContent = '';
  let content = '';
  let contentEmitBuffer = '';
  let insideTool = false;
  let currentToolOpenTag = TOOL_START;
  let emittedToolCallCount = 0;
  let completionTokens = 0;
  const toolCalls: ToolCall[] = [];
  let buffer = '';
  let pendingToolLeadIn = '';
  const deferTextForToolDetection = Array.isArray(tools) && tools.length > 0;

  const emitContent = async (text: string) => {
    if (!text || emittedToolCallCount > 0) return;
    content += text;
    if (emit) await emit(makeChunk(completionId, model, { content: text }));
  };

  const parseRecoverableToolCallBlock = (block: string, openTag: string): any => {
    try {
      return parseToolCallBlock(block, openTag, tools);
    } catch {}

    const args: Record<string, unknown> = {};
    const closedParameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let match: RegExpExecArray | null;
    let lastClosedEnd = 0;
    while ((match = closedParameterRe.exec(block)) !== null) {
      args[match[1]] = coerceParameterValue(match[2]);
      lastClosedEnd = closedParameterRe.lastIndex;
    }

    const tail = block.substring(lastClosedEnd);
    const unclosedParameterMatch = tail.match(/<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)$/i);
    if (unclosedParameterMatch) {
      args[unclosedParameterMatch[1]] = coerceParameterValue(unclosedParameterMatch[2]);
    }

    const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
    if (toolName) return { name: toolName, arguments: args };

    const natural = inferToolCallFromNaturalText(block, tools);
    if (natural) return natural;

    throw new Error('Recoverable tool call missing name');
  };

  const emitToolCallObject = async (toolCallObj: any) => {
    const rawToolName = toolCallObj.name || '';
    const resolvedToolName = resolveDeclaredToolName(rawToolName, tools);
    const toolName = resolvedToolName || rawToolName;

    let toolArgs: Record<string, unknown> = {};
    if (toolCallObj.arguments && typeof toolCallObj.arguments === 'object') {
      toolArgs = toolCallObj.arguments;
    } else {
      const keys = Object.keys(toolCallObj).filter(k => k !== 'name');
      for (const k of keys) toolArgs[k] = toolCallObj[k];
    }

    if (!toolName) throw new Error('Tool call missing name');
    if (Array.isArray(tools) && tools.length > 0 && !resolvedToolName) {
      throw new Error(`Tool call references unavailable tool '${rawToolName}'`);
    }

    const missingRequired = missingRequiredToolArgs(toolName, toolArgs, tools);
    if (missingRequired.length > 0) {
      throw new Error(`Tool call '${toolName}' is missing required argument(s): ${missingRequired.join(', ')}`);
    }

    const toolId = 'call_' + uuidv4();
    const toolCall: ToolCall = {
      index: emittedToolCallCount,
      id: toolId,
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(toolArgs) }
    };
    toolCalls.push(toolCall);
    if (emit) await emit(makeChunk(completionId, model, { tool_calls: [toolCall] }));
    emittedToolCallCount++;
  };

  const emitToolCallFromBlock = async (toolBlock: string, openTag: string) => {
    await emitToolCallObject(parseRecoverableToolCallBlock(toolBlock, openTag));
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);
        let dsMessageId: any = null;
        if (chunk.response_message_id) {
          dsMessageId = chunk.response_message_id;
        } else if (chunk.v && typeof chunk.v === 'object') {
          if (chunk.v.response && chunk.v.response.message_id) {
            dsMessageId = chunk.v.response.message_id;
          } else if (chunk.v.message_id) {
            dsMessageId = chunk.v.message_id;
          }
        } else if (chunk.message_id) {
          dsMessageId = chunk.message_id;
        }

        if (dsMessageId) updateSessionParent(uiSessionId, dsMessageId);

        let vStr = '';
        let foundStr = false;
        let isThinkingChunk = false;

        if (typeof chunk.p === 'string') {
          currentAppendPath = chunk.p;
          if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
            completionTokens = chunk.v;
          }
        }

        if (typeof chunk.v === 'string') {
          vStr = chunk.v;
          foundStr = true;
        } else if (chunk.v && typeof chunk.v === 'object') {
          if (chunk.v.response && chunk.v.response.fragments && chunk.v.response.fragments.length > 0) {
            const frag = chunk.v.response.fragments[0];
            if (typeof frag.content === 'string') {
              vStr = frag.content;
              foundStr = true;
              currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
              currentFragmentType = frag.type || '';
            }
          } else if (Array.isArray(chunk.v) && chunk.v.length > 0) {
            const firstObj = chunk.v[0];
            if (typeof firstObj.content === 'string') {
              vStr = firstObj.content;
              foundStr = true;
              currentAppendPath = firstObj.type === 'THINK' ? 'response/thinking_content' : 'response/content';
              currentFragmentType = firstObj.type || '';
            }
          }
        }

        if (chunk.p === 'response/fragments' && Array.isArray(chunk.v)) {
          const lastFrag = chunk.v[chunk.v.length - 1];
          if (lastFrag && lastFrag.type) currentFragmentType = lastFrag.type;
        }

        if (currentAppendPath.includes('thinking_content') ||
            currentAppendPath.includes('THINK') ||
            (currentAppendPath.includes('fragments/-1/content') && currentFragmentType === 'THINK')) {
          isThinkingChunk = true;
        }

        if (!foundStr || vStr === '' || vStr === 'FINISHED') continue;

        if (isThinkingChunk) {
          reasoningContent += vStr;
          const delta: ChoiceDelta = { reasoning_content: vStr };
          if (emit) await emit(makeChunk(completionId, model, delta));
          continue;
        }

        contentEmitBuffer += vStr;

        while (contentEmitBuffer.length > 0) {
          if (!insideTool) {
            const toolOpen = findToolOpen(contentEmitBuffer);
            if (toolOpen) {
              // Once a tool call appears, do not emit the lead-in text as
              // assistant content. OpenAI-compatible clients expect the whole
              // assistant turn to be a structured tool_calls message.
              pendingToolLeadIn += contentEmitBuffer.substring(0, toolOpen.startIdx);
              insideTool = true;
              currentToolOpenTag = toolOpen.openTag;
              contentEmitBuffer = contentEmitBuffer.substring(toolOpen.endIdx);
              continue;
            }

            const orphanToolCloseIdx = deferTextForToolDetection
              ? contentEmitBuffer.toLowerCase().indexOf(TOOL_END)
              : -1;
            if (orphanToolCloseIdx !== -1) {
              pendingToolLeadIn += contentEmitBuffer.substring(0, orphanToolCloseIdx);
              contentEmitBuffer = contentEmitBuffer.substring(orphanToolCloseIdx + TOOL_END.length);
              continue;
            }

            const partialStartIdx = findPartialToolOpenIndex(contentEmitBuffer);
            const flushIndex = partialStartIdx === -1 ? contentEmitBuffer.length : partialStartIdx;

            if (deferTextForToolDetection) {
              break;
            }

            const textToEmit = contentEmitBuffer.substring(0, flushIndex);
            await emitContent(textToEmit);
            contentEmitBuffer = contentEmitBuffer.substring(flushIndex);
            break;
          }

          const lowerBuffer = contentEmitBuffer.toLowerCase();
          const endIdx = lowerBuffer.indexOf(TOOL_END);
          if (endIdx === -1) break;

          const toolBlock = contentEmitBuffer.substring(0, endIdx).trim();
          try {
            await emitToolCallFromBlock(toolBlock, currentToolOpenTag);
            pendingToolLeadIn = '';
          } catch (e) {
            // Never leak internal tool-call XML to the user-visible content.
            // If the call cannot be parsed, restore any normal text that came
            // before it so the OpenAI response is not silently empty.
            warnToolParser('Dropping malformed tool call block', e);
            if (emittedToolCallCount === 0 && pendingToolLeadIn.trim().length > 0) {
              await emitContent(sanitizeToolArtifacts(pendingToolLeadIn));
            }
            pendingToolLeadIn = '';
          }

          insideTool = false;
          currentToolOpenTag = TOOL_START;
          contentEmitBuffer = contentEmitBuffer.substring(endIdx + TOOL_END.length);
        }
      } catch (e) {
        // Ignore partial or malformed DeepSeek chunks.
      }
    }
  }

  if (insideTool && contentEmitBuffer.trim().length > 0) {
    try {
      await emitToolCallFromBlock(contentEmitBuffer.trim(), currentToolOpenTag);
      pendingToolLeadIn = '';
    } catch (e) {
      warnToolParser('Dropping unclosed malformed tool call at end of stream', e);
      if (emittedToolCallCount === 0 && pendingToolLeadIn.trim().length > 0) {
        await emitContent(sanitizeToolArtifacts(pendingToolLeadIn));
      }
      pendingToolLeadIn = '';
    }
  }

  const remainingContent = `${pendingToolLeadIn}${contentEmitBuffer}`;
  if (!insideTool && remainingContent.length > 0 && emittedToolCallCount === 0) {
    const plainToolCalls = parsePlainTextToolCalls(remainingContent, tools);
    if (plainToolCalls.length > 0) {
      for (const call of plainToolCalls) {
        await emitToolCallObject(call);
      }
    } else {
      const fallbackContent = deferTextForToolDetection
        ? sanitizeToolArtifacts(remainingContent)
        : remainingContent;
      if (fallbackContent.trim().length > 0) {
        await emitContent(fallbackContent);
      }
    }
  }

  const usage: Usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 }
  };

  return {
    content,
    reasoningContent,
    toolCalls,
    finishReason: emittedToolCallCount > 0 ? 'tool_calls' : 'stop',
    usage
  };
}

async function peekStream(stream: ReadableStream): Promise<{ isEmpty: boolean; peekedStream: ReadableStream }> {
  const reader = stream.getReader();
  try {
    const { done, value } = await reader.read();
    if (done) {
      return { isEmpty: true, peekedStream: new ReadableStream({ start(c) { c.close(); } }) };
    }
    
    const peekedStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(value);
        try {
          while (true) {
            const { done: nextDone, value: nextValue } = await reader.read();
            if (nextDone) {
              controller.close();
              break;
            }
            controller.enqueue(nextValue);
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        reader.releaseLock();
      }
    });
    
    return { isEmpty: false, peekedStream };
  } catch (err) {
    reader.releaseLock();
    throw err;
  }
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    const messages = body.messages || [];
    const resolvedModel = resolveModel(body.model);
    if (!resolvedModel) {
      console.warn(`[Chat] Rejected unavailable model '${body.model}'.`);
      return c.json(modelNotFoundError(body.model), 404);
    }

    if ((body as any).prompt_cache_key) {
      console.log(`[Chat] prompt_cache_key accepted: ${String((body as any).prompt_cache_key).slice(0, 80)}`);
    }

    const isThinkingModel = resolvedModel.thinking;
    const isProModel = resolvedModel.pro;
    const telemetryModel = resolvedModel.root;
    const completionId = 'chatcmpl-' + uuidv4();

    if (!isStream) {
      let attempt = 0;
      const maxAttempts = 3;
      let lastError: any = null;
      let parsedResult: ParsedCompletion | null = null;
      let finalUiSessionId = '';

      while (attempt < maxAttempts) {
        attempt++;
        const telemetry = getModelTelemetry(telemetryModel);
        const currentTargetLimit = telemetry.detectedLimit;
        
        const compressed = compressMessages(messages, currentTargetLimit, serializeOpenAIMessages);
        const serialized = serializeOpenAIMessages(compressed);
        const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
        const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;
        const promptSize = finalPrompt.length;
        const promptTokens = Math.ceil(promptSize / 3.5);

        try {
          console.log(`[Chat] Attempt ${attempt}/${maxAttempts} (non-stream) with prompt length ${promptSize} chars.`);
          const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isProModel, null);
          
          const parsed = await parseDeepSeekStreamToOpenAI(
            result.stream,
            completionId,
            body.model,
            promptTokens,
            result.uiSessionId,
            (body as any).tools || []
          );

          if (parsed.content === '' && parsed.toolCalls.length === 0) {
            console.warn(`[Chat] Attempt ${attempt} (non-stream) response was empty.`);
            recordFailure(telemetryModel, promptSize);
            continue;
          }

          // Success!
          recordSuccess(telemetryModel, promptSize);
          parsedResult = parsed;
          finalUiSessionId = result.uiSessionId;
          break;
        } catch (err: any) {
          console.error(`[Chat] Attempt ${attempt} (non-stream) failed:`, err.message);
          lastError = err;
          if (isSessionInvalidError(err.message || String(err))) {
            break;
          }
          recordFailure(telemetryModel, promptSize);
          if (attempt >= maxAttempts) {
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (!parsedResult) {
        throw lastError || new Error("Failed to get a non-empty response from DeepSeek after multiple attempts.");
      }

      const message: any = {
        role: 'assistant',
        content: parsedResult.toolCalls.length > 0 ? null : parsedResult.content
      };
      if (parsedResult.reasoningContent) message.reasoning_content = parsedResult.reasoningContent;
      if (parsedResult.toolCalls.length > 0) message.tool_calls = parsedResult.toolCalls;

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: parsedResult.finishReason
        }],
        usage: parsedResult.usage
      });
    }

    // Streaming mode
    let deepSeekStream: ReadableStream | null = null;
    let uiSessionId = '';
    let attempt = 0;
    const maxAttempts = 3;
    let lastError: any = null;
    let promptSizeUsed = 0;

    while (attempt < maxAttempts) {
      attempt++;
      const telemetry = getModelTelemetry(telemetryModel);
      const currentTargetLimit = telemetry.detectedLimit;
      
      const compressed = compressMessages(messages, currentTargetLimit, serializeOpenAIMessages);
      const serialized = serializeOpenAIMessages(compressed);
      const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
      const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;
      promptSizeUsed = finalPrompt.length;

      try {
        console.log(`[Chat] Attempt ${attempt}/${maxAttempts} (stream) with prompt length ${promptSizeUsed} chars.`);
        const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isProModel, null);
        
        // Peek the stream to verify it has content
        const { isEmpty, peekedStream } = await peekStream(result.stream);
        if (isEmpty) {
          console.warn(`[Chat] Attempt ${attempt} (stream) peeked stream was empty.`);
          recordFailure(telemetryModel, promptSizeUsed);
          continue;
        }

        // Success!
        recordSuccess(telemetryModel, promptSizeUsed);
        deepSeekStream = peekedStream;
        uiSessionId = result.uiSessionId;
        break;
      } catch (err: any) {
        console.error(`[Chat] Attempt ${attempt} (stream) failed:`, err.message);
        lastError = err;
        if (isSessionInvalidError(err.message || String(err))) {
          break;
        }
        recordFailure(telemetryModel, promptSizeUsed);
        if (attempt >= maxAttempts) {
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!deepSeekStream) {
      throw lastError || new Error("Failed to get a valid stream from DeepSeek after multiple attempts.");
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const promptTokens = Math.ceil(promptSizeUsed / 3.5);

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      await writeEvent(makeChunk(completionId, body.model, { role: 'assistant' }));

      const parsed = await parseDeepSeekStreamToOpenAI(
        deepSeekStream!,
        completionId,
        body.model,
        promptTokens,
        uiSessionId,
        (body as any).tools || [],
        writeEvent
      );

      await writeEvent(makeChunk(completionId, body.model, {}, parsed.finishReason, parsed.usage));
      await streamWriter.write('data: [DONE]\n\n');
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    const errMessage = err?.message || String(err);

    let status = 500;
    let code = 'upstream_error';
    if (/account is suspended/i.test(errMessage)) {
      status = 403;
      code = 'deepseek_account_suspended';
    } else if (isSessionInvalidError(errMessage)) {
      status = 401;
      code = 'deepseek_session_invalid';
    } else if (/login is required|No cached DeepSeek session/i.test(errMessage)) {
      status = 401;
      code = 'deepseek_login_required';
    } else if (/chat input unavailable|Timeout waiting for chat input/i.test(errMessage)) {
      status = 409;
      code = 'deepseek_chat_unavailable';
    }

    return c.json({ error: { message: errMessage, type: code, code } }, status as any);
  }
}
