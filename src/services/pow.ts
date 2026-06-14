export type DeepSeekPowScene = 'completion_like' | 'upload_file';

export interface DeepSeekPowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  signature: string;
  expireAt?: number;
  expire_at?: number;
  expireAfter?: number;
  expire_after?: number;
}

export interface DeepSeekPowAnswer {
  algorithm: string;
  challenge: string;
  salt: string;
  answer: number;
  signature: string;
}

const TARGET_PATH_BY_SCENE: Record<DeepSeekPowScene, string> = {
  completion_like: '/api/v0/chat/completion',
  upload_file: '/api/v0/file/upload_file',
};

interface DeepSeekPowWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  wasm_solve: (
    retptr: number,
    challengePtr: number,
    challengeLen: number,
    prefixPtr: number,
    prefixLen: number,
    difficulty: number,
  ) => void;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
  __wbindgen_export_0: (size: number, align: number) => number;
}

let wasmExportsPromise: Promise<DeepSeekPowWasmExports> | null = null;

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function encodeDeepSeekPowHeader(answer: DeepSeekPowAnswer, targetPath: string): string {
  return Buffer.from(JSON.stringify({
    algorithm: answer.algorithm,
    challenge: answer.challenge,
    salt: answer.salt,
    answer: answer.answer,
    signature: answer.signature,
    target_path: targetPath,
  }), 'utf8').toString('base64');
}

function compactHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value) out[key] = value;
  }
  return out;
}

async function loadPowWasm(): Promise<DeepSeekPowWasmExports> {
  if (wasmExportsPromise) return wasmExportsPromise;

  wasmExportsPromise = (async () => {
    const wasmUrl = process.env.DEEPSPROXY_POW_WASM_URL
      || 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
    const response = await fetch(wasmUrl, {
      headers: {
        accept: 'application/wasm,*/*',
        referer: 'https://chat.deepseek.com/',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to load DeepSeek PoW WASM (${response.status} ${response.statusText}).`);
    }

    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
    const exports = instance.exports as DeepSeekPowWasmExports;
    if (
      !exports.memory
      || typeof exports.wasm_solve !== 'function'
      || typeof exports.__wbindgen_add_to_stack_pointer !== 'function'
      || typeof exports.__wbindgen_export_0 !== 'function'
    ) {
      throw new Error('DeepSeek PoW WASM exports are not compatible with the expected solver interface.');
    }

    return exports;
  })().catch((error) => {
    wasmExportsPromise = null;
    throw error;
  });

  return wasmExportsPromise;
}

function writeUtf8ToWasm(exports: DeepSeekPowWasmExports, value: string): { ptr: number; len: number } {
  const bytes = Buffer.from(value, 'utf8');
  const ptr = exports.__wbindgen_export_0(bytes.length, 1) >>> 0;
  new Uint8Array(exports.memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

async function solveWithWasm(challenge: DeepSeekPowChallenge): Promise<number | null> {
  const exports = await loadPowWasm();
  const expireAt = Number(challenge.expireAt ?? challenge.expire_at);
  const prefix = `${challenge.salt}_${expireAt}_`;
  const challengeString = String(challenge.challenge);
  const difficulty = Number(challenge.difficulty);
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);

  try {
    const challengeBytes = writeUtf8ToWasm(exports, challengeString);
    const prefixBytes = writeUtf8ToWasm(exports, prefix);
    exports.wasm_solve(
      retptr,
      challengeBytes.ptr,
      challengeBytes.len,
      prefixBytes.ptr,
      prefixBytes.len,
      difficulty,
    );

    const view = new DataView(exports.memory.buffer);
    const solved = view.getInt32(retptr, true) !== 0;
    if (!solved) return null;

    const answer = view.getFloat64(retptr + 8, true);
    if (!Number.isSafeInteger(answer)) {
      throw new Error(`DeepSeek PoW WASM returned a non-integer answer: ${answer}`);
    }
    return answer;
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}

function normalizeChallenge(raw: any): DeepSeekPowChallenge {
  const challenge = raw?.data?.biz_data?.challenge
    ?? raw?.biz_data?.challenge
    ?? raw?.challenge
    ?? raw?.data?.challenge;

  if (!challenge || typeof challenge !== 'object') {
    throw new Error('DeepSeek PoW challenge response did not include a challenge object.');
  }

  const normalized: DeepSeekPowChallenge = {
    algorithm: String(challenge.algorithm || ''),
    challenge: String(challenge.challenge || ''),
    salt: String(challenge.salt || ''),
    difficulty: Number(challenge.difficulty),
    signature: String(challenge.signature || ''),
    expireAt: Number(challenge.expireAt ?? challenge.expire_at ?? 0),
    expireAfter: Number(challenge.expireAfter ?? challenge.expire_after ?? 0),
  };

  if (normalized.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unsupported DeepSeek PoW algorithm: ${normalized.algorithm || '(missing)'}`);
  }
  if (!normalized.challenge || normalized.challenge.length % 2 !== 0) {
    throw new Error('Invalid DeepSeek PoW challenge hash.');
  }
  if (!normalized.salt || !normalized.signature) {
    throw new Error('Invalid DeepSeek PoW challenge metadata.');
  }
  if (!Number.isSafeInteger(normalized.difficulty) || normalized.difficulty <= 0) {
    throw new Error(`Invalid DeepSeek PoW difficulty: ${challenge.difficulty}`);
  }

  return normalized;
}

async function fetchPowChallenge(
  targetPath: string,
  sessionHeaders: Record<string, string>,
): Promise<DeepSeekPowChallenge> {
  const response = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: compactHeaders({
      accept: 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      authorization: sessionHeaders.authorization,
      cookie: sessionHeaders.cookie,
      'content-type': 'application/json',
      origin: 'https://chat.deepseek.com',
      referer: 'https://chat.deepseek.com/',
      'x-app-version': '2.0.0',
      'x-client-locale': 'pt_BR',
      'x-client-platform': 'web',
      'x-client-version': '2.0.0',
      'x-hif-dliq': sessionHeaders['x-hif-dliq'],
      'x-hif-leim': sessionHeaders['x-hif-leim'],
    }),
    body: JSON.stringify({ target_path: targetPath }),
  });

  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`DeepSeek PoW challenge endpoint returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = parsed?.msg ?? parsed?.message ?? response.statusText;
    throw new Error(`DeepSeek PoW challenge request failed (${response.status}): ${message}`);
  }

  const topCode = parsed?.code;
  const bizCode = parsed?.data?.biz_code ?? parsed?.biz_code;
  if (topCode !== undefined && topCode !== 0) {
    throw new Error(`DeepSeek PoW challenge request failed with code ${topCode}: ${parsed?.msg || parsed?.message || 'unknown error'}`);
  }
  if (bizCode !== undefined && bizCode !== 0) {
    const bizMsg = parsed?.data?.biz_msg ?? parsed?.biz_msg ?? 'unknown error';
    throw new Error(`DeepSeek PoW challenge request failed with biz_code ${bizCode}: ${bizMsg}`);
  }

  return normalizeChallenge(parsed);
}

export async function solveDeepSeekPowChallenge(challenge: DeepSeekPowChallenge): Promise<DeepSeekPowAnswer> {
  if (challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unsupported DeepSeek PoW algorithm: ${challenge.algorithm}`);
  }

  const expireAt = Number(challenge.expireAt ?? challenge.expire_at);
  const difficulty = Number(challenge.difficulty);
  const maxDifficulty = envInt('DEEPSPROXY_POW_MAX_DIFFICULTY', 20_000_000);
  const yieldEvery = envInt('DEEPSPROXY_POW_YIELD_EVERY', 25_000);

  if (!Number.isSafeInteger(difficulty) || difficulty <= 0) {
    throw new Error(`Invalid DeepSeek PoW difficulty: ${challenge.difficulty}`);
  }
  if (difficulty > maxDifficulty) {
    throw new Error(`DeepSeek PoW difficulty ${difficulty} exceeds DEEPSPROXY_POW_MAX_DIFFICULTY=${maxDifficulty}.`);
  }
  if (!Number.isFinite(expireAt) || expireAt <= 0) {
    throw new Error('Invalid DeepSeek PoW expiration timestamp.');
  }

  void yieldEvery;

  const answer = await solveWithWasm(challenge);
  if (answer === null) {
    throw new Error(`No DeepSeek PoW solution found before difficulty ${difficulty}.`);
  }

  return {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
  };
}

export async function createDeepSeekPowResponse(options: {
  scene?: DeepSeekPowScene;
  targetPath?: string;
  sessionHeaders: Record<string, string>;
}): Promise<string> {
  const targetPath = options.targetPath ?? TARGET_PATH_BY_SCENE[options.scene ?? 'completion_like'];
  const startedAt = Date.now();
  const challenge = await fetchPowChallenge(targetPath, options.sessionHeaders);
  const answer = await solveDeepSeekPowChallenge(challenge);
  const elapsed = Date.now() - startedAt;

  if (process.env.DEEPSPROXY_DEBUG === 'true' || process.env.LOG_LEVEL === 'debug') {
    console.log(`[DeepSeek PoW] solved scene=${options.scene ?? 'completion_like'} difficulty=${challenge.difficulty} answer=${answer.answer} duration=${elapsed}ms`);
  }

  return encodeDeepSeekPowHeader(answer, targetPath);
}

export function createDeepSeekPowHeaderForChallenge(
  challenge: DeepSeekPowChallenge,
  targetPath: string,
  answer: number,
): string {
  return encodeDeepSeekPowHeader({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
  }, targetPath);
}
