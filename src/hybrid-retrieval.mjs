// Hybrid retrieval reference: keyword (BM25-lite) + embedding search, fused by
// reciprocal rank fusion, with an optional rerank stage. Providers are injected,
// so any embedding / rerank service (hosted or self-hosted) can be plugged in.
// In-memory educational reference; not a production index.

export function tokenize(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function chunkText(text, { size = 400, overlap = 50 } = {}) {
  if (size <= overlap) throw new RangeError('size must be greater than overlap');
  const out = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Offline embedder for tests and key-free demos: hashed bag of tokens.
export function hashEmbedder(dim = 256) {
  return async (texts) => texts.map((t) => {
    const v = new Array(dim).fill(0);
    for (const tok of tokenize(t)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
      v[(h >>> 0) % dim] += 1;
    }
    return v;
  });
}

// Adapter for any OpenAI-compatible /embeddings endpoint. URL, key and model
// come from the caller (e.g. environment variables); nothing is hard-coded.
export function httpEmbedder({ url, apiKey, model, fetchImpl = fetch }) {
  return async (texts) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) throw new Error(`embedding request failed: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.data) || body.data.length !== texts.length) {
      throw new Error('malformed embedding response');
    }
    return body.data.map((d) => d.embedding);
  };
}

export function reciprocalRankFusion(rankings, k = 60) {
  const score = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export class HybridIndex {
  #docs = [];
  #vecs = [];
  #embed;
  constructor({ embed = hashEmbedder() } = {}) { this.#embed = embed; }

  async add(docs) {
    const vecs = await this.#embed(docs.map((d) => d.text));
    docs.forEach((d, i) => { this.#docs.push(d); this.#vecs.push(vecs[i]); });
  }

  #keywordRank(query) {
    const q = new Set(tokenize(query));
    const df = new Map();
    const toks = this.#docs.map((d) => tokenize(d.text));
    toks.forEach((ts) => new Set(ts).forEach((t) => df.set(t, (df.get(t) ?? 0) + 1)));
    const n = this.#docs.length;
    return toks
      .map((ts, i) => {
        let s = 0;
        for (const t of q) {
          const tf = ts.filter((x) => x === t).length;
          if (tf) s += (tf / (tf + 1.2)) * Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        }
        return [i, s];
      })
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([i]) => i);
  }

  async search(query, { limit = 5, rerank } = {}) {
    const [qv] = await this.#embed([query]);
    const vecRank = this.#vecs
      .map((v, i) => [i, cosine(qv, v)])
      .sort((a, b) => b[1] - a[1])
      .map(([i]) => i);
    const fused = reciprocalRankFusion([this.#keywordRank(query), vecRank]).slice(0, Math.max(limit, 20));
    let hits = fused.map((i) => this.#docs[i]);
    if (rerank) {
      const scores = await rerank(query, hits.map((h) => h.text));
      if (!Array.isArray(scores) || scores.length !== hits.length) throw new Error('malformed rerank response');
      hits = hits.map((h, i) => [h, scores[i]]).sort((a, b) => b[1] - a[1]).map(([h]) => h);
    }
    return hits.slice(0, limit);
  }
}
