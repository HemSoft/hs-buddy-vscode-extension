import * as vscode from 'vscode';
import type { CopilotSession } from './types';

/** Chars-per-token fallback ratio when vscode.lm API is unavailable */
const CHARS_PER_TOKEN_FALLBACK = 4;

/**
 * Estimates tokens for a session using the VS Code Language Model API
 * when available, falling back to character-based estimation.
 *
 * Note: These are estimates based on *visible* transcript text only.
 * Actual token usage is higher because system prompts, file context,
 * and tool results are not captured in transcripts.
 */
export async function estimateSessionTokens(session: CopilotSession): Promise<void> {
  const model = await getLanguageModel();

  if (model) {
    // Use the actual model tokenizer for better estimates
    const [inputTokens, outputTokens, reasoningTokens, toolArgTokens] = await Promise.all([
      countTokensSafe(model, session.inputChars, CHARS_PER_TOKEN_FALLBACK),
      countTokensSafe(model, session.outputChars, CHARS_PER_TOKEN_FALLBACK),
      countTokensSafe(model, session.reasoningChars, CHARS_PER_TOKEN_FALLBACK),
      countTokensSafe(model, session.toolArgChars, CHARS_PER_TOKEN_FALLBACK),
    ]);

    session.estimatedInputTokens = inputTokens;
    session.estimatedOutputTokens = outputTokens + reasoningTokens + toolArgTokens;
    session.estimatedTotalTokens = session.estimatedInputTokens + session.estimatedOutputTokens;
  } else {
    // Fallback: character-based estimation
    session.estimatedInputTokens = Math.round(session.inputChars / CHARS_PER_TOKEN_FALLBACK);
    session.estimatedOutputTokens = Math.round(
      (session.outputChars + session.reasoningChars + session.toolArgChars) / CHARS_PER_TOKEN_FALLBACK
    );
    session.estimatedTotalTokens = session.estimatedInputTokens + session.estimatedOutputTokens;
  }
}

/** Format token count for display */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return `${tokens}`;
}

// ─── Internals ────────────────────────────────────────────

let cachedModel: vscode.LanguageModelChat | null | undefined;

async function getLanguageModel(): Promise<vscode.LanguageModelChat | null> {
  if (cachedModel !== undefined) {
    return cachedModel;
  }

  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    cachedModel = models.length > 0 ? models[0] : null;
  } catch {
    cachedModel = null;
  }

  return cachedModel;
}

/**
 * Count tokens using model tokenizer, falling back to char-based estimate.
 * Uses a synthetic string of the right length since we only store char counts.
 */
async function countTokensSafe(
  model: vscode.LanguageModelChat,
  charCount: number,
  fallbackRatio: number
): Promise<number> {
  if (charCount === 0) {
    return 0;
  }

  try {
    // countTokens expects a string or message array.
    // We create a representative string of the right length.
    // Using spaces is fast and gives a reasonable lower bound.
    const sampleSize = Math.min(charCount, 8000);
    const sample = 'x'.repeat(sampleSize);
    const sampleTokens = await model.countTokens(sample);
    // Scale by actual length
    return Math.round((sampleTokens / sampleSize) * charCount);
  } catch {
    return Math.round(charCount / fallbackRatio);
  }
}
