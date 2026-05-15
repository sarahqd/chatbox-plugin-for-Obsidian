/**
 * WikiChat Plugin - Type Definitions
 */

// ============== Provider Types ==============

export type LLMProvider = string;

export type LLMProviderApiStyle = 'ollama' | 'openai' | 'anthropic';
export type LLMProviderHosting = 'local' | 'cloud' | 'hybrid';
export type LLMProviderAuthMode = 'none' | 'optional' | 'required';

export interface LLMProviderMetadata {
    id: LLMProvider;
    displayName: string;
    apiStyle: LLMProviderApiStyle;
    hosting: LLMProviderHosting;
    authMode: LLMProviderAuthMode;
    defaultBaseUrl: string;
    defaultModelId: string;
    modelIdHint: string;
    baseUrlLabel?: string;
    baseUrlDescription?: string;
    apiKeyLabel?: string;
    apiKeyDescription?: string;
    enabledByDefault?: boolean;
}

export const PROVIDER_CATALOG: LLMProviderMetadata[] = [
    {
        id: 'Ollama',
        displayName: 'Ollama',
        apiStyle: 'ollama',
        hosting: 'local',
        authMode: 'none',
        defaultBaseUrl: 'http://localhost:11434',
        defaultModelId: 'llama3.2',
        modelIdHint: 'e.g., llama3.2, qwen2.5',
        baseUrlLabel: 'Ollama URL',
        baseUrlDescription: 'Default Ollama API address',
        enabledByDefault: true,
    },
    {
        id: 'LM Studio',
        displayName: 'LM Studio',
        apiStyle: 'openai',
        hosting: 'local',
        authMode: 'none',
        defaultBaseUrl: 'http://127.0.0.1:1234/v1',
        defaultModelId: 'local-model',
        modelIdHint: 'e.g., local-model, qwen2.5-7b-instruct',
        baseUrlDescription: 'Local OpenAI-compatible endpoint exposed by LM Studio',
    },
    {
        id: 'vLLM',
        displayName: 'vLLM',
        apiStyle: 'openai',
        hosting: 'local',
        authMode: 'optional',
        defaultBaseUrl: 'http://localhost:8000/v1',
        defaultModelId: 'hosted-model',
        modelIdHint: 'e.g., hosted-model, meta-llama/Llama-3.1-8B-Instruct',
        baseUrlDescription: 'OpenAI-compatible endpoint exposed by vLLM',
        apiKeyDescription: 'Optional if your vLLM gateway requires authentication',
    },
    {
        id: 'LocalAI',
        displayName: 'LocalAI',
        apiStyle: 'openai',
        hosting: 'local',
        authMode: 'optional',
        defaultBaseUrl: 'http://localhost:8080/v1',
        defaultModelId: 'local-model',
        modelIdHint: 'e.g., local-model, mistral, phi-4',
        baseUrlDescription: 'OpenAI-compatible endpoint exposed by LocalAI',
        apiKeyDescription: 'Optional if your LocalAI gateway requires authentication',
    },
    {
        id: 'OpenAI',
        displayName: 'OpenAI',
        apiStyle: 'openai',
        hosting: 'cloud',
        authMode: 'required',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelId: 'gpt-4o-mini',
        modelIdHint: 'e.g., gpt-4o, gpt-4o-mini',
        apiKeyDescription: 'API key used for OpenAI requests',
    },
    {
        id: 'OpenRouter',
        displayName: 'OpenRouter',
        apiStyle: 'openai',
        hosting: 'cloud',
        authMode: 'required',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        defaultModelId: 'openai/gpt-4o-mini',
        modelIdHint: 'e.g., openai/gpt-4o-mini, anthropic/claude-3.5-sonnet',
        apiKeyDescription: 'API key used for OpenRouter requests',
    },
    {
        id: 'Groq',
        displayName: 'Groq',
        apiStyle: 'openai',
        hosting: 'cloud',
        authMode: 'required',
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
        defaultModelId: 'llama-3.3-70b-versatile',
        modelIdHint: 'e.g., llama-3.3-70b-versatile, mixtral-8x7b-32768',
        apiKeyDescription: 'API key used for Groq requests',
    },
    {
        id: 'DeepSeek',
        displayName: 'DeepSeek',
        apiStyle: 'openai',
        hosting: 'cloud',
        authMode: 'required',
        defaultBaseUrl: 'https://api.deepseek.com/v1',
        defaultModelId: 'deepseek-chat',
        modelIdHint: 'e.g., deepseek-chat, deepseek-reasoner',
        apiKeyDescription: 'API key used for DeepSeek requests',
    },
    {
        id: 'Anthropic',
        displayName: 'Anthropic',
        apiStyle: 'anthropic',
        hosting: 'cloud',
        authMode: 'required',
        defaultBaseUrl: 'https://api.anthropic.com/v1',
        defaultModelId: 'claude-3-5-sonnet-latest',
        modelIdHint: 'e.g., claude-3-5-sonnet-latest',
        apiKeyDescription: 'API key used for Anthropic requests',
    },
    {
        id: 'OpenAI Compatible',
        displayName: 'OpenAI Compatible',
        apiStyle: 'openai',
        hosting: 'hybrid',
        authMode: 'optional',
        defaultBaseUrl: 'https://api.example.com/v1',
        defaultModelId: 'custom-model',
        modelIdHint: 'Enter model ID',
        baseUrlDescription: 'Generic OpenAI-compatible endpoint',
        apiKeyDescription: 'Optional if the endpoint requires bearer authentication',
    },
];

export function getProviderMetadata(provider: LLMProvider): LLMProviderMetadata {
    return PROVIDER_CATALOG.find((entry) => entry.id === provider) || {
        id: provider,
        displayName: provider,
        apiStyle: 'openai',
        hosting: 'hybrid',
        authMode: 'optional',
        defaultBaseUrl: 'https://api.example.com/v1',
        defaultModelId: 'custom-model',
        modelIdHint: 'Enter model ID',
        baseUrlDescription: 'Generic API endpoint for this provider',
        apiKeyDescription: 'Optional if the endpoint requires bearer authentication',
    };
}

export interface ProviderConfig {
    name: LLMProvider;
    displayName: string;
    apiKey?: string;
    baseUrl?: string;
    enabled: boolean;
}

export interface ModelConfig {
    id: string;           // Unique identifier
    name: string;         // Display name
    provider: LLMProvider;
    modelId: string;      // Actual model ID for API calls
    baseUrl: string;      // Base URL for this model/provider
    apiKey?: string;      // Override provider API key (for custom models)
    contextLength?: number;
    description?: string;
    isDefault?: boolean;
    supportsTools?: boolean;
    supportsVision?: boolean;
    maxToolIterations?: number; // Maximum assistant-tool rounds before continuation.
    maxToolCallsPerTurn?: number; // Maximum total tool calls before continuation.
    maxToolWallTimeMs?: number; // Maximum tool-loop wall time before continuation.
    maxContinuationPasses?: number; // Automatic continuation passes when budgets are hit.
    maxToolResultCharsRatio?: number; // Max chars per tool result as ratio of context chars.
    historyTurns?: number; // Number of recent turns sent to the model.
    retrievalTopN?: number; // BM25 candidate count before rerank.
    retrievalRerankTopK?: number; // Final reranked chunk count injected into prompt.
}

export interface EmbeddingModelConfig {
    id: string;           // Unique identifier
    name: string;         // Display name
    provider: LLMProvider;
    modelId: string;      // Actual embedding model ID for API calls
    baseUrl: string;      // Base URL for this embedding model/provider
    apiKey?: string;      // Optional API key
    dimensions?: number;  // Embedding vector dimensions (informational)
}

// ============== Settings ==============

export interface LLMWikiSettings {
    // Legacy settings (derived from the selected model for backward compatibility)
    ollamaUrl: string;
    model: string;
    
    // Provider settings
    providers: ProviderConfig[];
    models: ModelConfig[];
    currentModelId: string;
    
    wikiPath: string;
    sourcesPath: string;
    indexPath: string;
    autoIngest: boolean;
    autoLint: boolean;
    buildSearchIndexOnStartup: boolean; // Build BM25 metadata index when Obsidian layout is ready
    rebuildGeneratedIndexOnStartup: boolean; // Also rewrite human-readable WikiIndex slices on startup
    lintInterval: number;
    lastLintTime: number;         // Last completed lint timestamp (ms)
    lastStaleCheckTime: number;   // Last stale check timestamp (ms) - runs monthly
    // Chat enhancement settings
    maxContextTokens: number;      // Max context token count
    autoSaveChat: boolean;         // Auto save chat
    chatHistoryPath: string;       // Chat history save path
    showHistoryPanel: boolean;     // Whether to show history panel
    maxHistoryDisplay: number;     // Max history panel display count
    // Embedding / semantic search settings
    embeddingModels: EmbeddingModelConfig[];
    currentEmbeddingModelId: string; // '' = BM25 only
    summaryMaxLength: number;        // Max chars for summary frontmatter field
}

// Default provider configurations
export const DEFAULT_PROVIDERS: ProviderConfig[] = PROVIDER_CATALOG.map((provider) => ({
    name: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.defaultBaseUrl,
    enabled: provider.enabledByDefault ?? false,
}));

// Default model configurations (empty - user must add models)
export const DEFAULT_MODELS: ModelConfig[] = [];

export const DEFAULT_SETTINGS: LLMWikiSettings = {
    // Legacy settings
    ollamaUrl: 'http://localhost:11434',
    model: '',
    
    // Provider settings
    providers: DEFAULT_PROVIDERS,
    models: DEFAULT_MODELS,
    currentModelId: '',
    
    wikiPath: 'Wiki',
    sourcesPath: 'Sources',
    indexPath: 'WikiIndex',
    autoIngest: true,
    autoLint: false,
    buildSearchIndexOnStartup: false,
    rebuildGeneratedIndexOnStartup: false,
    lintInterval: 60,
    lastLintTime: 0,
    lastStaleCheckTime: 0,
    // Chat enhancement default settings
    maxContextTokens: 8192,
    autoSaveChat: false,
    chatHistoryPath: 'Sources/chats',
    showHistoryPanel: true,
    maxHistoryDisplay: 3,
    // Embedding / semantic search defaults
    embeddingModels: [],
    currentEmbeddingModelId: '',
    summaryMaxLength: 200,
};

// ============== Ollama API Types ==============

export interface OllamaMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCalls?: OllamaToolCall[];
    toolCallId?: string;
}

export interface OllamaToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: Record<string, unknown>;
    };
}

export interface OllamaTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, {
                type: string;
                description: string;
                enum?: string[];
            }>;
            required?: string[];
        };
    };
}

export interface OllamaChatRequest {
    model: string;
    messages: OllamaMessage[];
    tools?: OllamaTool[];
    stream?: boolean;
}

export interface OllamaChatResponse {
    model: string;
    message: OllamaMessage;
    done: boolean;
}

export interface OllamaEmbeddingRequest {
    model: string;
    prompt: string;
}

export interface OllamaEmbeddingResponse {
    embedding: number[];
}

// ============== Tool Types ==============

export interface ToolContext {
    vault: unknown; // Obsidian Vault
    app: unknown; // Obsidian App
    settings: LLMWikiSettings;
}

export interface ToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
}

export type ToolHandler = (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: OllamaTool['function']['parameters'];
    handler: ToolHandler;
}

// ============== Wiki Types ==============

export interface WikiPageFrontmatter {
    title: string;
    created: string;
    updated: string;
    summary?: string;   // Brief summary stored in frontmatter for zero-I/O search
    tags: string[];
    related: string[];  // Links to original files or related wiki pages (using [[link]] format)
}

export interface WikiPage {
    path: string;
    frontmatter: WikiPageFrontmatter;
    content: string;
    summary: string;
}

export interface IngestResult {
    success: boolean;
    sourcePath: string;
    targetPath?: string;
    operation: 'create' | 'update' | 'skip';
    entities: string[];
    message: string;
}

export interface QueryResult {
    answer: string;
    sources: string[];
    confidence: number;
}

export interface LintIssue {
    type: 'broken_link' | 'contradiction' | 'duplicate' | 'stale';
    path: string;
    description: string;
    suggestion?: string;
}

export interface LintResult {
    issues: LintIssue[];
    fixed: number;
    pending: number;
    lastLintTime: number;
}

export type SearchIndexStatus = 'idle' | 'building' | 'ready' | 'error';

// ============== Chat Types ==============

// Context type
export interface ChatContext {
    id: string;
    type: 'file' | 'wiki' | 'folder' | 'text' | 'snippet';
    name: string;
    path?: string;
    content: string;
    tokens: number;
    // Obsidian internal link format: [[path]] or [[path|display]]
    link?: string;
    // For snippet type: line range
    startLine?: number;
    endLine?: number;
}

// File reference in message (parsed from [[file]] syntax)
export interface FileReference {
    path: string;
    displayName?: string;
    fullMatch: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    toolCalls?: OllamaToolCall[];
    pending?: boolean;
    context?: ChatContext[];  // Associated context
}

// Chat session type
export interface ChatSession {
    id: string;
    title: string;
    messages: ChatMessage[];
    model: string;
    createdAt: number;
    updatedAt: number;
    totalTokens: number;
}

// Model info
export interface ModelInfo {
    name: string;
    size?: number;
    modified_at?: string;
    digest?: string;
}

export interface ChatState {
    messages: ChatMessage[];
    isLoading: boolean;
    pendingAction?: {
        type: string;
        params: Record<string, unknown>;
        description: string;
    };
    currentSession?: ChatSession;
    contexts: ChatContext[];
    currentModel: string;
}

// ============== Operation Log Types ==============

export interface OperationLog {
    timestamp: string;
    type: 'ingest' | 'query' | 'lint' | 'manual';
    source?: string;
    target?: string;
    operation: string;
    entities?: string[];
    status: 'success' | 'failed' | 'pending';
    message: string;
}
