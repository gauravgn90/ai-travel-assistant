import path from "node:path";

/**
 * Everything on disk is addressed relative to the repository root rather than
 * to `import.meta.url`, because the same modules are loaded both by `tsx`
 * (scripts, from source) and by the Next.js server build (from `.next`).
 */
export const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();

export const paths = {
  knowledgeBase: path.join(projectRoot, "knowledge-base"),
  dataDir: path.join(projectRoot, "data"),
  indexDir: path.join(projectRoot, "data", "index"),
  indexFile: path.join(projectRoot, "data", "index", "singapore.index.json"),
  mcpServers: path.join(projectRoot, "mcp-servers"),
} as const;
