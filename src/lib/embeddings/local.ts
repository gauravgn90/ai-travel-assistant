import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";

type FeatureExtractor = (
  input: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export interface LocalEmbeddingsParams extends EmbeddingsParams {
  model?: string;
  batchSize?: number;
}

/**
 * Sentence-transformer embeddings that run in-process through ONNX Runtime.
 *
 * This exists so the knowledge base can be indexed and queried without any
 * vendor API key or quota — useful for local development, for CI, and for the
 * Anthropic/Groq setups, since neither vendor sells an embedding endpoint.
 * Weights are downloaded once from the Hugging Face CDN and cached on disk.
 */
export class LocalEmbeddings extends Embeddings {
  readonly model: string;
  private readonly batchSize: number;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(params: LocalEmbeddingsParams = {}) {
    super(params);
    this.model = params.model ?? "Xenova/all-MiniLM-L6-v2";
    this.batchSize = params.batchSize ?? 32;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const extractor = await this.load();
    const vectors: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize);
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      vectors.push(...output.tolist());
    }

    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedDocuments([text]);
    if (!vector) throw new Error("Local embedding model returned no vector");
    return vector;
  }

  private load(): Promise<FeatureExtractor> {
    this.extractor ??= import("@huggingface/transformers")
      .then(({ pipeline }) =>
        pipeline("feature-extraction", this.model, { dtype: "fp32" }),
      )
      .then((pipe) => pipe as unknown as FeatureExtractor)
      .catch((cause: unknown) => {
        this.extractor = null;
        throw new Error(
          `Could not start the local embedding model "${this.model}". ` +
            `It requires the optional dependency @huggingface/transformers — install it with ` +
            `\`npm install @huggingface/transformers\`, or set EMBEDDING_PROVIDER to openai or google.`,
          { cause },
        );
      });

    return this.extractor;
  }
}
