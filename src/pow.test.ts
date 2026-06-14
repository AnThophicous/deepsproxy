import test from 'node:test';
import assert from 'node:assert';

import {
  createDeepSeekPowHeaderForChallenge,
  type DeepSeekPowChallenge,
} from './services/pow.ts';

test('deepseek pow header uses browser bundle payload shape', () => {
  const challenge: DeepSeekPowChallenge = {
    algorithm: 'DeepSeekHashV1',
    challenge: '00',
    salt: 'salt',
    difficulty: 1,
    signature: 'sig',
    expireAt: 1760000000000,
  };

  const encoded = createDeepSeekPowHeaderForChallenge(challenge, '/api/v0/chat/completion', 0);
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));

  assert.deepStrictEqual(decoded, {
    algorithm: 'DeepSeekHashV1',
    challenge: '00',
    salt: 'salt',
    answer: 0,
    signature: 'sig',
    target_path: '/api/v0/chat/completion',
  });
});
