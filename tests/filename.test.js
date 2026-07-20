const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeFilename,
  buildSuggestedFilename,
  resolveRequestedFilename,
} = require('../src/core/filename.js');
const { ensureMp4Filename } = require('../src/core/download.js');

test('video A title becomes A.mp4', () => {
  assert.equal(buildSuggestedFilename('Alpha Video', 'aaa'), 'Alpha Video.mp4');
});

test('video B title becomes B.mp4', () => {
  assert.equal(buildSuggestedFilename('Beta Video', 'bbb'), 'Beta Video.mp4');
});

test('replaces Windows-invalid characters and trims trailing dots and spaces', () => {
  assert.equal(sanitizeFilename('Nice:Name*?'), 'Nice Name');
  // path segments are reduced to the leaf name
  assert.equal(sanitizeFilename('C:\\folder\\clip name'), 'clip name');
  assert.equal(sanitizeFilename('../evil/name'), 'name');
});

test('protects Windows reserved device names', () => {
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('lpt1.txt'), '_lpt1');
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
  assert.equal(buildSuggestedFilename('clip.mp4.mp4', 'id'), 'clip.mp4');
});

test('txt html json become mp4', () => {
  assert.equal(buildSuggestedFilename('report.txt', 'id'), 'report.mp4');
  assert.equal(buildSuggestedFilename('page.html', 'id'), 'page.mp4');
  assert.equal(buildSuggestedFilename('data.json', 'id'), 'data.mp4');
  assert.equal(ensureMp4Filename('file.txt'), 'file.mp4');
});

test('empty requested filename falls back to title then videoId', () => {
  assert.equal(resolveRequestedFilename('', 'Real Title', 'vid1'), 'Real Title.mp4');
  assert.equal(resolveRequestedFilename('   ', '', 'vid2'), 'vid2.mp4');
  assert.equal(resolveRequestedFilename('', '', 'vid3'), 'vid3.mp4');
});

test('user requested filename is preserved after sanitization', () => {
  assert.equal(
    resolveRequestedFilename('Мой тестовый ролик', 'Ignored Title', 'vid'),
    'Мой тестовый ролик.mp4',
  );
  assert.equal(
    resolveRequestedFilename('C:\\temp\\custom name.txt', 'Title', 'vid'),
    'custom name.mp4',
  );
});
