export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResponse {
  content: string;
  tokensUsed: number;
}

export interface LlmProvider {
  name: string;
  generate(
    messages: LlmMessage[],
    options: { maxTokens: number },
  ): Promise<LlmResponse>;
}
