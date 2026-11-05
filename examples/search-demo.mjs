// Key-free demo: node examples/search-demo.mjs
// To use a real embedding service, set EMBED_URL / EMBED_MODEL (and EMBED_API_KEY if needed).
import { HybridIndex, httpEmbedder } from '../src/hybrid-retrieval.mjs';

const embed = process.env.EMBED_URL
  ? httpEmbedder({ url: process.env.EMBED_URL, apiKey: process.env.EMBED_API_KEY, model: process.env.EMBED_MODEL })
  : undefined; // falls back to the offline hash embedder

const idx = new HybridIndex({ embed });
await idx.add([
  { id: 'n1', text: 'Mark an operation UNKNOWN when a timeout hides the receipt' },
  { id: 'n2', text: 'Never silently switch hosts when a target was chosen explicitly' },
  { id: 'n3', text: 'Pin QA verification to the exact code revision' },
]);
for (const h of await idx.search('timeout without a receipt', { limit: 2 })) console.log(h.id, '-', h.text);
