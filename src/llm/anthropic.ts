/**
 * Anthropic Provider
 * Implements LLM provider interface for Anthropic Claude API
 */

import type { OllamaMessage, OllamaTool, OllamaToolCall } from '../types';
import type { LLMProviderInterface, LLMProviderConfig, LLMChatOptions, LLMStreamOptions, LLMResponse } from './types';

export class AnthropicProvider implements LLMProviderInterface {
    readonly name = 'anthropic';
    private apiKey: string;
    private baseUrl: string;
    private model: string;

    constructor(config: LLMProviderConfig) {
        this.apiKey = config.apiKey || '';
        this.baseUrl = config.baseUrl || 'https://api.anthropic.com/v1';
        this.model = config.model || 'claude-3-5-sonnet-20241022';
    }

    configure(config: LLMProviderConfig): void {
        this.apiKey = config.apiKey || this.apiKey;
        this.baseUrl = config.baseUrl || this.baseUrl;
        this.model = config.model || this.model;
    }

    private formatMessages(messages: OllamaMessage[]): {
        system?: string;
        messages: Array<{
            role: 'user' | 'assistant';
            content: string | Array<{
                type: 'text';
                text: string;
            } | {
                type: 'tool_result';
                tool_use_id: string;
                content: string;
            }>;
        }>;
    } {
        const formatted: Array<{
            role: 'user' | 'assistant';
            content: string | Array<{
                type: 'text';
                text: string;
            } | {
                type: 'tool_result';
                tool_use_id: string;
                content: string;
            }>;
        }> = [];

        for (const msg of messages) {
            if (msg.role === 'system') continue; // System handled separately

            if (msg.role === 'tool') {
                // Tool result - add to last user message or create new one
                const lastMsg = formatted[formatted.length - 1];
                if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
                    lastMsg.content.push({
                        type: 'tool_result',
                        tool_use_id: msg.toolCallId || '',
                        content: msg.content,
                    });
                } else {
                    formatted.push({
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: msg.toolCallId || '',
                            content: msg.content,
                        }],
                    });
                }
            } else if (msg.role === 'user' || msg.role === 'assistant') {
                const content: Array<{
                    type: 'text';
                    text: string;
                } | {
                    type: 'tool_use';
                    id: string;
                    name: string;
                    input: object;
                }> = [];

                if (msg.content) {
                    content.push({ type: 'text', text: msg.content });
                }

                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    for (const tc of msg.toolCalls) {
                        content.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function.name,
                            input: tc.function.arguments,
                        });
                    }
                }

                formatted.push({
                    role: msg.role,
                    content: content.length === 1 && content[0].type === 'text' 
                        ? msg.content 
                        : content as Array<{
                            type: 'text';
                            text: string;
                        } | {
                            type: 'tool_result';
                            tool_use_id: string;
                            content: string;
                        }>,
                });
            }
        }

        return { messages: formatted };
    }

    private formatTools(tools: OllamaTool[]): Array<{
        name: string;
        description: string;
        input_schema: object;
    }> {
        return tools.map(tool => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
        }));
    }

    async chat(options: LLMChatOptions): Promise<LLMResponse> {
        const { messages, tools, systemPrompt, temperature, maxTokens } = options;

        const formatted = this.formatMessages(messages);

        const body: Record<string, unknown> = {
            model: this.model,
            messages: formatted.messages,
            max_tokens: maxTokens || 4096,
        };

        if (systemPrompt) {
            body.system = systemPrompt;
        }

        if (tools && tools.length > 0) {
            body.tools = this.formatTools(tools);
        }

        if (temperature !== undefined) {
            body.temperature = temperature;
        }

        const response = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${response.status} ${error}`);
        }

        const data = await response.json();

        // Extract text content and tool calls
        let textContent = '';
        const toolCalls: OllamaToolCall[] = [];

        for (const block of data.content) {
            if (block.type === 'text') {
                textContent += block.text;
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: {
                        name: block.name,
                        arguments: block.input as Record<string, unknown>,
                    },
                });
            }
        }

        const message: OllamaMessage = {
            role: 'assistant',
            content: textContent,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };

        return {
            message,
            usage: data.usage ? {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens: data.usage.input_tokens + data.usage.output_tokens,
            } : undefined,
        };
    }

    async chatStream(options: LLMStreamOptions): Promise<LLMResponse> {
        const { messages, tools, systemPrompt, temperature, maxTokens, onChunk, signal } = options;

        const formatted = this.formatMessages(messages);

        const body: Record<string, unknown> = {
            model: this.model,
            messages: formatted.messages,
            max_tokens: maxTokens || 4096,
            stream: true,
        };

        if (systemPrompt) {
            body.system = systemPrompt;
        }

        if (tools && tools.length > 0) {
            body.tools = this.formatTools(tools);
        }

        if (temperature !== undefined) {
            body.temperature = temperature;
        }

        const response = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal,  // Pass abort signal
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${response.status} ${error}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let fullContent = '';
        const toolCalls: OllamaToolCall[] = [];
        // Use a different structure for streaming tool calls
        let currentToolCall: {
            id: string;
            name: string;
            argumentsStr: string;
        } | null = null;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        try {
                            const parsed = JSON.parse(data);

                            if (parsed.type === 'content_block_delta') {
                                if (parsed.delta?.type === 'text_delta') {
                                    fullContent += parsed.delta.text;
                                    onChunk(parsed.delta.text);
                                } else if (parsed.delta?.type === 'input_json_delta') {
                                    if (currentToolCall) {
                                        currentToolCall.argumentsStr += (parsed.delta.partial_json || '');
                                    }
                                }
                            } else if (parsed.type === 'content_block_start') {
                                if (parsed.content_block?.type === 'tool_use') {
                                    currentToolCall = {
                                        id: parsed.content_block.id,
                                        name: parsed.content_block.name,
                                        argumentsStr: '',
                                    };
                                }
                            } else if (parsed.type === 'content_block_stop') {
                                if (currentToolCall) {
                                    try {
                                        toolCalls.push({
                                            id: currentToolCall.id,
                                            type: 'function',
                                            function: {
                                                name: currentToolCall.name,
                                                arguments: JSON.parse(currentToolCall.argumentsStr || '{}'),
                                            },
                                        });
                                    } catch {
                                        // Skip invalid JSON
                                    }
                                    currentToolCall = null;
                                }
                            }
                        } catch {
                            // Skip invalid JSON
                        }
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
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };

        return { message };
    }

    async healthCheck(): Promise<boolean> {
        try {
            if (!this.apiKey) return false;
            // Anthropic doesn't have a health endpoint, so we just check if API key exists
            return true;
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