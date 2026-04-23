/**
 * OpenAI Provider
 * Implements LLM provider interface for OpenAI API
 */

import type { OllamaMessage, OllamaTool, OllamaToolCall } from '../types';
import type { LLMProviderInterface, LLMProviderConfig, LLMChatOptions, LLMStreamOptions, LLMResponse } from './types';

export class OpenAIProvider implements LLMProviderInterface {
    readonly name = 'openai';
    private apiKey: string;
    private baseUrl: string;
    private model: string;

    constructor(config: LLMProviderConfig) {
        this.apiKey = config.apiKey || '';
        this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
        this.model = config.model || 'gpt-4o';
    }

    configure(config: LLMProviderConfig): void {
        this.apiKey = config.apiKey || this.apiKey;
        this.baseUrl = config.baseUrl || this.baseUrl;
        this.model = config.model || this.model;
    }

    private formatMessages(messages: OllamaMessage[], systemPrompt?: string): Array<{
        role: 'system' | 'user' | 'assistant' | 'tool';
        content: string;
        tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
        }>;
        tool_call_id?: string;
    }> {
        const formatted: Array<{
            role: 'system' | 'user' | 'assistant' | 'tool';
            content: string;
            tool_calls?: Array<{
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
            }>;
            tool_call_id?: string;
        }> = [];

        if (systemPrompt) {
            formatted.push({ role: 'system', content: systemPrompt });
        }

        for (const msg of messages) {
            const item: {
                role: 'system' | 'user' | 'assistant' | 'tool';
                content: string;
                tool_calls?: Array<{
                    id: string;
                    type: 'function';
                    function: { name: string; arguments: string };
                }>;
                tool_call_id?: string;
            } = {
                role: msg.role,
                content: msg.content || '',
            };

            if (msg.toolCalls && msg.toolCalls.length > 0) {
                item.tool_calls = msg.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                        name: tc.function.name,
                        arguments: JSON.stringify(tc.function.arguments),
                    },
                }));
            }

            if (msg.toolCallId) {
                item.tool_call_id = msg.toolCallId;
            }

            formatted.push(item);
        }

        return formatted;
    }

    private formatTools(tools: OllamaTool[]): Array<{
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: object;
        };
    }> {
        return tools.map(tool => ({
            type: 'function' as const,
            function: {
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
            },
        }));
    }

    async chat(options: LLMChatOptions): Promise<LLMResponse> {
        const { messages, tools, systemPrompt, temperature, maxTokens } = options;

        const body: Record<string, unknown> = {
            model: this.model,
            messages: this.formatMessages(messages, systemPrompt),
        };

        if (tools && tools.length > 0) {
            body.tools = this.formatTools(tools);
        }

        if (temperature !== undefined) {
            body.temperature = temperature;
        }

        if (maxTokens !== undefined) {
            body.max_tokens = maxTokens;
        }

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} ${error}`);
        }

        const data = await response.json();
        const choice = data.choices[0];

        const message: OllamaMessage = {
            role: 'assistant',
            content: choice.message.content || '',
        };

        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            message.toolCalls = choice.message.tool_calls.map((tc: {
                id: string;
                type: string;
                function: { name: string; arguments: string };
            }) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                    name: tc.function.name,
                    arguments: JSON.parse(tc.function.arguments),
                },
            }));
        }

        return {
            message,
            usage: data.usage ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            } : undefined,
        };
    }

    async chatStream(options: LLMStreamOptions): Promise<LLMResponse> {
        const { messages, tools, systemPrompt, temperature, maxTokens, onChunk, signal } = options;

        const body: Record<string, unknown> = {
            model: this.model,
            messages: this.formatMessages(messages, systemPrompt),
            stream: true,
        };

        if (tools && tools.length > 0) {
            body.tools = this.formatTools(tools);
        }

        if (temperature !== undefined) {
            body.temperature = temperature;
        }

        if (maxTokens !== undefined) {
            body.max_tokens = maxTokens;
        }

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal,  // Pass abort signal
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} ${error}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let fullContent = '';
        const toolCalls: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
        }> = [];

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim().startsWith('data:'));

                for (const line of lines) {
                    const data = line.replace(/^data:\s*/, '').trim();
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;

                        if (delta?.content) {
                            fullContent += delta.content;
                            onChunk(delta.content);
                        }

                        if (delta?.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                if (tc.id) {
                                    toolCalls.push({
                                        id: tc.id,
                                        type: 'function',
                                        function: { name: '', arguments: '' },
                                    });
                                }
                                const idx = toolCalls.length - 1;
                                if (tc.function?.name) {
                                    toolCalls[idx].function.name = tc.function.name;
                                }
                                if (tc.function?.arguments) {
                                    toolCalls[idx].function.arguments += tc.function.arguments;
                                }
                            }
                        }
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }
        } catch (error) {
            // Check if this was an abort error
            if (signal?.aborted) {
                throw new Error('Request aborted');
            }
            throw error;
        } finally {
            reader.releaseLock();
        }

        const message: OllamaMessage = {
            role: 'assistant',
            content: fullContent,
        };

        if (toolCalls.length > 0) {
            message.toolCalls = toolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                    name: tc.function.name,
                    arguments: JSON.parse(tc.function.arguments),
                },
            }));
        }

        return { message };
    }

    async embed(text: string): Promise<number[]> {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: 'text-embedding-3-small',
                input: text,
            }),
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const data = await response.json();
        return data.data[0].embedding;
    }

    async listModels(): Promise<string[]> {
        const response = await fetch(`${this.baseUrl}/models`, {
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
            },
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const data = await response.json();
        return data.data
            .filter((m: { id: string }) => m.id.includes('gpt'))
            .map((m: { id: string }) => m.id);
    }

    async healthCheck(): Promise<boolean> {
        try {
            if (!this.apiKey) return false;
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                },
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    setModel(model: string): void {
        this.model = model;
    }

    getModel(): string {
        return this.model;
    }
}