import { config } from "./config.ts";

type Extractor = (
  input: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractor: Promise<Extractor> | null = null;

/** all-MiniLM-L6-v2 through ONNX Runtime, in this process. It needs no API key
 *  and no quota, so indexing and asking both work offline once the weights are
 *  cached. Vectors come back L2-normalised, which makes inner product equal
 *  cosine similarity - the metric the FAISS index is built for. */
function load(): Promise<Extractor> {
  extractor ??= import("@huggingface/transformers")
    .then(({ pipeline }) => pipeline("feature-extraction", config.embeddingModel, { dtype: "fp32" }))
    .then((pipe) => pipe as unknown as Extractor);
  return extractor;
}

export async function embed(texts: string[]): Promise<number[][]> {
  const run = await load();
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += 32) {
    const batch = await run(texts.slice(i, i + 32), { pooling: "mean", normalize: true });
    vectors.push(...batch.tolist());
  }

  return vectors;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  if (!vector) throw new Error("The embedding model returned no vector.");
  return vector;
}
