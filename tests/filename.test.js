const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeFilename,
  buildSuggestedFilename,
} = require('../src/core/filename.js');
const { ensureMp4Filename } = require('../src/core/download.js');

test('replaces Windows-invalid characters and trims trailing dots and spaces', () => {
  assert.equal(sanitizeFilename('  A<B>:C"D/E\\F|G?H*...  '), 'A B C D E F G H');
});

test('protects Windows reserved device names', () => {
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('lpt1.txt'), '_lpt1.txt');
});

test('uses fallback when a title becomes empty', () => {
  assert.equal(sanitizeFilename('***', 'abc123'), 'abc123');
});

test('builds an MP4 suggested filename with a conservative length', () => {
  const filename = buildSuggestedFilename('x'.repeat(300), 'video-id');
  assert.equal(filename.endsWith('.mp4'), true);
  assert.equal(filename.length <= 184, true);
});

test('keeps Russian titles and never suggests TXT', () => {
  const filename = buildSuggestedFilename('Проверка ролика: тест/№1', 'vid');
  assert.match(filename, /\.mp4$/i);
  assert.equal(filename.toLowerCase().includes('.txt'), false);
  assert.equal(ensureMp4Filename(filename), filename);
});

test('does not duplicate mp4 extension from title', () => {
  assert.equal(buildSuggestedFilename('clip.mp4', 'id'), 'clip.mp4');
});
