import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ImageTextExtractionError,
  normalizeOcrContent,
  recordImageCandidates,
  requestQwenOcr,
  validateImageTextRequest,
} from '../server/services/image-text-extraction.js';

test('record image order matches the admin gallery and prefers local copies', () => {
  const first = 'https://sns-webpic-qc.xhscdn.com/first.jpg';
  const second = 'https://sns-webpic-qc.xhscdn.com/second.jpg';
  assert.deepEqual(
    recordImageCandidates({
      cover_local: '/media/covers/cover.jpg',
      image_urls: [first, second],
      image_local_urls: [{
        source_url: first,
        source_hash: 'abc',
        url: '/media/images/first.jpg',
      }],
    }),
    [
      { url: '/media/covers/cover.jpg', sourceUrl: '', ref: '/media/covers/cover.jpg' },
      { url: '/media/images/first.jpg', sourceUrl: first, ref: first },
      { url: second, sourceUrl: second, ref: second },
    ],
  );

  assert.deepEqual(
    recordImageCandidates({
      cover_local: '/media/covers/cover.jpg',
      image_urls: [first],
      image_local_urls: [],
    }),
    [
      { url: '/media/covers/cover.jpg', sourceUrl: '', ref: '/media/covers/cover.jpg' },
      { url: first, sourceUrl: first, ref: first },
    ],
  );

  assert.deepEqual(
    recordImageCandidates({
      cover_local: '/media/covers/cover.jpg',
      image_urls: [],
      image_local_urls: [],
    }),
    [{ url: '/media/covers/cover.jpg', sourceUrl: '', ref: '/media/covers/cover.jpg' }],
    'a cover alone can also be selected for on-demand text extraction',
  );

  assert.deepEqual(
    recordImageCandidates({
      cover_url: first,
      cover_local: '/media/covers/stale-cover.jpg',
      image_urls: [first],
      image_local_urls: [],
    }),
    [{ url: first, sourceUrl: first, ref: first }],
    'a cover never creates a duplicate or ambiguous body-image reference',
  );
});

test('image text request only accepts a bounded stable image reference and refresh flag', () => {
  assert.deepEqual(
    validateImageTextRequest({ imageRef: 'https://example.com/selected.png', refresh: true }),
    { ok: true, imageRef: 'https://example.com/selected.png', refresh: true },
  );
  assert.equal(validateImageTextRequest({ imageRef: '' }).error, 'invalid_image_ref');
  assert.equal(validateImageTextRequest({ imageRef: 1 }).error, 'invalid_image_ref');
  assert.equal(
    validateImageTextRequest({
      imageRef: 'https://example.com/selected.png',
      imageUrl: 'http://127.0.0.1/private',
      apiKey: 'must-not-be-accepted',
      model: 'must-not-be-accepted',
    }).error,
    'unsupported_fields',
  );
});

test('OCR content keeps original line breaks and removes a wrapping code fence', () => {
  assert.equal(
    normalizeOcrContent('```text\n第一行\n第二行：A-123\n```'),
    '第一行\n第二行：A-123',
  );
  assert.equal(
    normalizeOcrContent([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]),
    '甲\n乙',
  );
});

test('Qwen OCR sends exactly one selected image and requests plain visible text', async () => {
  let requestBody;
  const result = await requestQwenOcr({
    config: {
      apiKey: 'test-key',
      model: 'qwen3.5-ocr',
      endpoint: 'https://dashscope.example/compatible-mode/v1',
    },
    dataUrl: 'data:image/png;base64,aGVsbG8=',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '标题\n正文内容' } }],
        usage: { prompt_tokens: 120, completion_tokens: 8 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(result.text, '标题\n正文内容');
  assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 8 });
  assert.equal(result.truncated, false);
  assert.equal(requestBody.model, 'qwen3.5-ocr');
  assert.equal(requestBody.messages.length, 1);
  assert.equal(requestBody.messages[0].role, 'user');
  assert.equal(requestBody.messages[0].content[0].type, 'text');
  assert.match(requestBody.messages[0].content[0].text, /output only the text content/i);
  assert.equal(
    requestBody.messages[0].content.filter(item => item.type === 'image_url').length,
    1,
  );
  assert.deepEqual(requestBody.messages[0].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,aGVsbG8=' },
    min_pixels: 3072,
    max_pixels: 8388608,
  });
  assert.equal(Object.hasOwn(requestBody, 'response_format'), false);
  assert.equal(requestBody.messages.some(message => message.role === 'system'), false);
});

test('Qwen OCR marks output that stopped at the model token limit', async () => {
  const result = await requestQwenOcr({
    config: {
      apiKey: 'test-key',
      model: 'qwen3.5-ocr',
      endpoint: 'https://dashscope.example/compatible-mode/v1',
    },
    dataUrl: 'data:image/png;base64,aGVsbG8=',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: 'length',
        message: { content: '尚未完整输出的文字' },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  assert.equal(result.text, '尚未完整输出的文字');
  assert.equal(result.truncated, true);
});

test('Qwen OCR rejects coordinate-only detector output instead of exposing it as copyable text', async () => {
  await assert.rejects(
    requestQwenOcr({
      config: {
        apiKey: 'test-key',
        model: 'qwen3.5-ocr',
        endpoint: 'https://dashscope.example/compatible-mode/v1',
      },
      dataUrl: 'data:image/png;base64,aGVsbG8=',
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: [
              '96,30,255,147,90',
              '80,165,400,210,0',
              '74,228,412,276,0',
              '78,293,390,341,0',
            ].join('\n'),
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    error => {
      assert.ok(error instanceof ImageTextExtractionError);
      assert.equal(error.code, 'ocr_invalid_response');
      assert.equal(error.status, 502);
      return true;
    },
  );
});

test('Qwen OCR maps rate limits to a stable customer-facing error', async () => {
  await assert.rejects(
    requestQwenOcr({
      config: {
        apiKey: 'test-key',
        model: 'qwen3.5-ocr',
        endpoint: 'https://dashscope.example/compatible-mode/v1',
      },
      dataUrl: 'data:image/png;base64,aGVsbG8=',
      fetchImpl: async () => new Response('rate limited', { status: 429 }),
    }),
    error => {
      assert.ok(error instanceof ImageTextExtractionError);
      assert.equal(error.code, 'ocr_rate_limited');
      assert.equal(error.status, 429);
      assert.doesNotMatch(error.message, /rate limited/i);
      return true;
    },
  );
});
