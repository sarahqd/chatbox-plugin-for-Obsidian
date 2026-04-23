/**
 * Ingest Flow
 * Incremental ingestion of new documents into the Wiki
 */

import { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, IngestResult } from '../types';
import { getOllamaClient } from '../ollama/client';
import { executeTool, getOllamaTools } from '../tools';

const SYSTEM_PROMPT = `You are a knowledge base management assistant. Your task is to integrate new document content into the existing Wiki knowledge base.

## CRITICAL CONSTRAINT: Content Fidelity
**STRICTLY PROHIBITED**: You must NOT introduce any content, information, or knowledge that does not exist in the original source document.

**ALLOWED**:
- Extract, summarize, and reorganize information that exists in the source document
- Create structure and formatting for existing content
- Add [[wikilinks]] to connect related concepts only when [[wikilinks]] exists

**FORBIDDEN**:
- Adding external knowledge not mentioned in the source
- Inferring or hallucinating facts not explicitly stated
- Adding explanations, examples, or details not present in the original
- Adding any information "you know" that isn't in the source document

When in doubt, omit content rather than add external information.

## Workflow
1. Analyze new documents, extract key information, entities and concepts FROM THE SOURCE ONLY
2. Check Wiki index, find related existing pages
3. Decide whether to create new pages or update existing ones
4. Use the provided tools to perform file operations
5. Ensure appropriate [[bidirectional links]] are added

## Wiki Page Standards
- Each page must have YAML frontmatter
- Use [[wikilinks]] syntax to connect related concepts
- Keep content concise and structured
- Provide a brief summary for each page
- ALL content must originate from the source document

## Available Tools
You can use the following tools to manipulate files and Wiki:
- read_file: Read file contents
- write_file: Write to file
- list_files: List directory files
- search_files: Search file contents
- create_wiki_page: Create new Wiki page
- update_wiki_page: Update existing Wiki page
- add_backlink: Add bidirectional link
- update_index: Update Wiki index
- log_operation: Log operation record

Please call these tools as needed to complete the task.`;

/**
 * Ingest a file into the Wiki
 */
export async function ingestFile(
    app: App,
    settings: LLMWikiSettings,
    filePath: string,
    onProgress?: (message: string) => void
): Promise<IngestResult> {
    const client = getOllamaClient(settings.ollamaUrl, settings.model);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        // Step 1: Read the source file
        onProgress?.(`Reading file: ${filePath}`);
        const file = app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            return {
                success: false,
                sourcePath: filePath,
                operation: 'skip',
                entities: [],
                message: 'File does not exist',
            };
        }

        const content = await app.vault.read(file);

        // Step 2: Read Wiki index for context
        let indexContent = '';
        const indexPath = `${settings.wikiPath}/index.md`;
        const indexFile = app.vault.getAbstractFileByPath(indexPath);
        if (indexFile instanceof TFile) {
            indexContent = await app.vault.read(indexFile);
        }

        // Step 3: Ask LLM to process the document
        onProgress?.('Analyzing document content...');
        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `Please integrate the following document content into the Wiki.

## Source File Path
${filePath}

## Document Content
\`\`\`
${content}
\`\`\`

## Current Wiki Index
\`\`\`
${indexContent || '(Wiki is empty)'}
\`\`\`

Please analyze the document, extract key entities and concepts, and create or update corresponding Wiki pages.`,
            },
        ];

        // Step 4: Run agentic loop with tool calling
        const tools = getOllamaTools();
        let response = await client.chat(messages, tools, SYSTEM_PROMPT);
        let iterations = 0;
        const maxIterations = 10;
        const entities: string[] = [];

        while (iterations < maxIterations) {
            iterations++;

            if (response.toolCalls && response.toolCalls.length > 0) {
                // Process tool calls
                for (const toolCall of response.toolCalls) {
                    onProgress?.(`Executing tool: ${toolCall.function.name}`);
                    
                    const result = await executeTool(
                        toolCall.function.name,
                        toolCall.function.arguments,
                        context
                    );

                    // Extract entities from tool calls
                    if (toolCall.function.name === 'create_wiki_page') {
                        const title = toolCall.function.arguments.title as string;
                        entities.push(title);
                    }

                    // Add tool result to messages
                    messages.push({
                        role: 'assistant',
                        content: '',
                        toolCalls: response.toolCalls,
                    });
                    messages.push({
                        role: 'tool',
                        content: JSON.stringify(result),
                        toolCallId: toolCall.id,
                    });
                }

                // Get next response
                response = await client.chat(messages, tools, SYSTEM_PROMPT);
            } else {
                // No tool calls, we're done
                break;
            }
        }

        // Step 5: Update the Wiki index
        onProgress?.('Updating Wiki index...');
        await executeTool('update_index', {}, context);

        // Step 6: Log the operation
        await executeTool(
            'log_operation',
            {
                type: 'ingest',
                source: filePath,
                operation: 'Document ingestion',
                entities: entities.join(','),
                status: 'success',
                message: `Successfully ingested document, created ${entities.length} pages`,
            },
            context
        );

        return {
            success: true,
            sourcePath: filePath,
            operation: entities.length > 0 ? 'create' : 'update',
            entities,
            message: `Successfully ingested document, extracted ${entities.length} entities`,
        };
    } catch (error) {
        return {
            success: false,
            sourcePath: filePath,
            operation: 'skip',
            entities: [],
            message: String(error),
        };
    }
}

/**
 * Ingest raw content into the Wiki
 */
export async function ingestContent(
    app: App,
    settings: LLMWikiSettings,
    content: string,
    title?: string,
    onProgress?: (message: string) => void
): Promise<IngestResult> {
    const client = getOllamaClient(settings.ollamaUrl, settings.model);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        // Read Wiki index for context
        let indexContent = '';
        const indexPath = `${settings.wikiPath}/index.md`;
        const indexFile = app.vault.getAbstractFileByPath(indexPath);
        if (indexFile instanceof TFile) {
            indexContent = await app.vault.read(indexFile);
        }

        onProgress?.('Analyzing content...');
        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `Please integrate the following content into the Wiki.

${title ? `## Title\n${title}\n\n` : ''}## Content
\`\`\`
${content}
\`\`\`

## Current Wiki Index
\`\`\`
${indexContent || '(Wiki is empty)'}
\`\`\`

Please analyze the content, extract key entities and concepts, and create or update corresponding Wiki pages.`,
            },
        ];

        const tools = getOllamaTools();
        let response = await client.chat(messages, tools, SYSTEM_PROMPT);
        let iterations = 0;
        const maxIterations = 10;
        const entities: string[] = [];

        while (iterations < maxIterations) {
            iterations++;

            if (response.toolCalls && response.toolCalls.length > 0) {
                for (const toolCall of response.toolCalls) {
                    onProgress?.(`Executing tool: ${toolCall.function.name}`);
                    
                    const result = await executeTool(
                        toolCall.function.name,
                        toolCall.function.arguments,
                        context
                    );

                    if (toolCall.function.name === 'create_wiki_page') {
                        const pageTitle = toolCall.function.arguments.title as string;
                        entities.push(pageTitle);
                    }

                    messages.push({
                        role: 'assistant',
                        content: '',
                        toolCalls: response.toolCalls,
                    });
                    messages.push({
                        role: 'tool',
                        content: JSON.stringify(result),
                        toolCallId: toolCall.id,
                    });
                }

                response = await client.chat(messages, tools, SYSTEM_PROMPT);
            } else {
                break;
            }
        }

        await executeTool('update_index', {}, context);

        await executeTool(
            'log_operation',
            {
                type: 'ingest',
                operation: 'Content ingestion',
                entities: entities.join(','),
                status: 'success',
                message: `Successfully ingested content, created ${entities.length} pages`,
            },
            context
        );

        return {
            success: true,
            sourcePath: '(Clipboard)',
            operation: entities.length > 0 ? 'create' : 'update',
            entities,
            message: `Successfully ingested content, extracted ${entities.length} entities`,
        };
    } catch (error) {
        return {
            success: false,
            sourcePath: '(Clipboard)',
            operation: 'skip',
            entities: [],
            message: String(error),
        };
    }
}
