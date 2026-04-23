/**
 * LLM Provider Types
 * Unified types for all LLM providers
 */

import type { OllamaMessage, OllamaTool, OllamaToolCall } from '../types';

// Use OllamaMessage as the base message type for all providers
export type LLMMessage = OllamaMessage;
export type LLMTool = OllamaTool;
export type LLMToolCall = OllamaToolCall;

export interface LLMChatOptions {
    messages: OllamaMessage[];
    tools?: OllamaTool[];
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
}

export interface LLMStreamOptions extends LLMChatOptions {
    onChunk: (text: string) => void;
    signal?: AbortSignal;  // For stream cancellation
}

export interface LLMResponse {
    message: OllamaMessage;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export interface LLMProviderInterface {
    readonly name: string;
    
    chat(options: LLMChatOptions): Promise<LLMResponse>;
    chatStream(options: LLMStreamOptions): Promise<LLMResponse>;
    embed?(text: string): Promise<number[]>;
    listModels?(): Promise<string[]>;
    healthCheck(): Promise<boolean>;
}

export interface LLMProviderConfig {
    apiKey?: string;
    baseUrl?: string;
    model: string;
    defaultModel?: string;
}