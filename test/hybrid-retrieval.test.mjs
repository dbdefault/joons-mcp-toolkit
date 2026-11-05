import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridIndex, chunkText, reciprocalRankFusion, httpEmbedder, cosine } from '../src/hybrid-retrieval.mjs';

const docs = [
  { id: 'a', text: 'Idempotent request IDs prevent duplicate side effects in agent jobs' },
  { id: 'b', text: 'Golf swing tempo and grip pressure tips' },
  { id: 'c', text: 'Retry on timeout can run the operation twice, so mark the outcome UNKNOWN' },
];

test('hybrid search ranks the relevant document first', async () => {
  const idx = new HybridIndex();
  await idx.add(docs);
  const hits = await idx.search('duplicate request side effects', { limit: 2 });
  assert.equal(hits[0].id, 'a');
});

test('rerank stage can reorder results', async () => {
  const idx = new HybridIndex();
  await idx.add(docs);
  const hits = await idx.search('timeout retry', { limit: 3, rerank: async (_q, ts) => ts.map((t) => (t.includes('Golf') ? 9 : 0)) });
  assert.equal(hits[0].id, 'b');
});

test('malformed rerank response is rejected, not treated as success', async () => {
  const idx = new HybridIndex();
  await idx.add(docs);
  await assert.rejects(idx.search('x', { rerank: async () => [1] }), /malformed rerank/);
});

test('chunkText overlaps and rejects bad sizes', () => {
  assert.equal(chunkText('abcdefghij', { size: 4, overlap: 1 }).length, 3);
  assert.throws(() => chunkText('abc', { size: 2, overlap: 2 }), RangeError);
});

test('rank fusion rewards agreement between rankers', () => {
  assert.equal(reciprocalRankFusion([[1, 2, 3], [2, 1, 3]])[2], 3);
});

test('httpEmbedder validates the response shape and status', async () => {
  const ok = httpEmbedder({ url: 'http://x', model: 'm', fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) }) });
  assert.deepEqual(await ok(['t']), [[1, 0]]);
  const bad = httpEmbedder({ url: 'http://x', model: 'm', fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
  await assert.rejects(bad(['t']), /malformed/);
  const down = httpEmbedder({ url: 'http://x', model: 'm', fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(down(['t']), /503/);
  assert.equal(cosine([1, 0], [1, 0]), 1);
});
