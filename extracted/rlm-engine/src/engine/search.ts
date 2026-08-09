/** LLM-powered search: delegates to the llm hook for knowledge retrieval.
 *  Agents call `await search("query")` to get evidence snippets. */
export function llmSearch(llm: (prompt: string) => Promise<string>): (query: string) => Promise<string> {
  return async (query: string) => {
    try {
      return await llm(
        `Search query: "${query}"\n\nProvide 3 factual evidence-based snippets about this. Format as:\n[1] <specific claim>\n[2] <specific claim>\n[3] <specific claim>`,
      );
    } catch {
      return "search unavailable";
    }
  };
}
