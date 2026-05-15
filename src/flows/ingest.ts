/**
 * Ingest Flow
 * Incremental ingestion of new documents into the Wiki
 */

import { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, IngestResult } from '../types';
import { getLLMClient } from '../llm/client';
import { executeTool, getOllamaTools } from '../tools';

export const SYSTEM_PROMPT = `You are a knowledge base management assistant. Your task is to integrate new document content into the existing Wiki knowledge base.

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

## CRITICAL CONSTRAINT: Source-Supported Topic Creation
You must distinguish between substantively described topics and shallow keywords.

Only create or update a Wiki page for a topic when the current source document explicitly gives that topic meaningful content, such as a definition, description, procedure, factual details, relationships, examples, or enough context to support a standalone note.

Do NOT create a Wiki page merely because a keyword, name, or term appears in the document. A term is a shallow keyword when it is only mentioned once, appears only in a list, tag, heading, quote, citation, or passing reference, or lacks explanation in the source document.

For shallow keywords:
- You may preserve them as text in a source-supported summary or body
- You may use them as tags or related-link candidates when appropriate
- You must NOT expand them into standalone entries
- You must NOT add your own explanation, background, examples, or encyclopedia-style details

## Workflow
1. Analyze new documents, extract only source-supported topics, relationships, and facts FROM THE SOURCE ONLY
2. Check Wiki index, find related existing pages
3. Create or update pages only for topics substantively described by the current source
4. Use the provided tools to perform file operations
5. Ensure appropriate [[bidirectional links]] are added

## Wiki Page Standards
- Each page must have YAML frontmatter
- Put metadata fields (title, summary, tags, related, created, updated) in frontmatter only
- Do not duplicate metadata sections in body content (no extra # Title, ## Summary, ## Related Links, or ## Tags blocks unless explicitly requested)
- Use [[wikilinks]] syntax to connect related concepts
- Keep content concise and structured
- Provide a brief summary for each page
- ALL content must originate from the source document
- Every created or updated page must be supported by content present in the current source document

## Available Tools
You can use the following tools to manipulate files and Wiki:
- read_file: Read file contents
- write_file: Write to file
- list_files: List directory files
- search_files: Search file contents
- create_wiki_page: Create new Wiki page
- update_wiki_page: Update existing Wiki page
- Read_Summary: Read only the Summary section
- Update_Summary: Modify only the Summary section
- Read_Property: Read only one frontmatter property
- Update_Property: Modify only one frontmatter property
- Update_Content: Modify only the Content section
- Read_Part: Read only one named section
- Update_Part: Modify only one named section
- add_backlink: Add bidirectional link
- update_index: Update Wiki index
- log_operation: Log operation record

Tool selection rules:
- Prefer Read_Part when you only need one named section from an existing page.
- Prefer Update_Content when only the main body should change and Summary or frontmatter must stay intact.
- Prefer Update_Part when changing one specific heading block other than broad full-page replacement.
- Use update_wiki_page only for full-body replacement, append operations, or source-link maintenance that affects the page more broadly.

Please call these tools as needed to complete the task.`;

async function readWikiIndex(app: App, settings: LLMWikiSettings): Promise<string> {
    const idxDir = settings.indexPath || 'WikiIndex';
    const indexPath = `${idxDir}/index.md`;
    const indexFile = app.vault.getAbstractFileByPath(indexPath);
    if (indexFile instanceof TFile) {
        return app.vault.read(indexFile);
    }
    return '';
}

async function runIngestAgentLoop(
    settings: LLMWikiSettings,
    context: ToolContext,
    messages: OllamaMessage[],
    onProgress?: (message: string) => void
): Promise<string[]> {
    const client = getLLMClient(settings);
    const tools = getOllamaTools();
    const entities: string[] = [];
    let response = (await client.chat({ messages, tools, systemPrompt: SYSTEM_PROMPT })).message;
    let iterations = 0;
    const maxIterations = 10;

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
                    const title = toolCall.function.arguments.title as string;
                    entities.push(title);
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

            response = (await client.chat({ messages, tools, systemPrompt: SYSTEM_PROMPT })).message;
        } else {
            break;
        }
    }

    return entities;
}

async function ingestFileCore(
    app: App,
    settings: LLMWikiSettings,
    filePath: string,
    indexContent: string,
    onProgress?: (message: string) => void
): Promise<IngestResult> {
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

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

Please analyze the document, extract only source-supported topics and relationships, and create or update Wiki pages only when each page's content is grounded in the current document.`,
        },
    ];

    const entities = await runIngestAgentLoop(settings, context, messages, onProgress);

    return {
        success: true,
        sourcePath: filePath,
        operation: entities.length > 0 ? 'create' : 'update',
        entities,
        message: `Successfully ingested document, extracted ${entities.length} entities`,
    };
}

/**
 * Ingest a file into the Wiki
 */
export async function ingestFile(
    app: App,
    settings: LLMWikiSettings,
    filePath: string,
    onProgress?: (message: string) => void
): Promise<IngestResult> {
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        const indexContent = await readWikiIndex(app, settings);
        const ingestResult = await ingestFileCore(app, settings, filePath, indexContent, onProgress);

        // Step 3: Update the Wiki index
        onProgress?.('Updating Wiki index...');
        await executeTool('update_index', {}, context);

        // Step 4: Log the operation
        await executeTool(
            'log_operation',
            {
                type: 'ingest',
                source: filePath,
                operation: 'Document ingestion',
                entities: ingestResult.entities.join(','),
                status: ingestResult.success ? 'success' : 'failed',
                message: ingestResult.message,
            },
            context
        );

        return ingestResult;
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
 * Batch ingest files into the Wiki with shared index loading.
 */
export async function ingestFiles(
    app: App,
    settings: LLMWikiSettings,
    filePaths: string[],
    onProgress?: (message: string, index: number, total: number) => void
): Promise<IngestResult[]> {
    if (filePaths.length === 0) {
        return [];
    }

    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    const indexContent = await readWikiIndex(app, settings);
    const total = filePaths.length;
    const results: IngestResult[] = [];
    const allEntities: string[] = [];

    for (let i = 0; i < filePaths.length; i++) {
        const currentPath = filePaths[i];
        onProgress?.(`Ingesting file ${i + 1}/${total}: ${currentPath}`, i, total);

        const result = await ingestFileCore(app, settings, currentPath, indexContent, (message) => {
            onProgress?.(message, i, total);
        });

        results.push(result);
        allEntities.push(...result.entities);
    }

    onProgress?.('Updating Wiki index (batch)...', total, total);
    await executeTool('update_index', {}, context);

    await executeTool(
        'log_operation',
        {
            type: 'ingest',
            operation: 'Batch document ingestion',
            entities: allEntities.join(','),
            status: 'success',
            message: `Successfully ingested ${total} files, extracted ${allEntities.length} entities`,
        },
        context
    );

    return results;
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
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        const indexContent = await readWikiIndex(app, settings);

        onProgress?.('Analyzing content...');
        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `Please integrate the following content into the Wiki.

${title ? `## Title\n${title}\n\n` : ''}
\`\`\`
${content}
\`\`\`

## Current Wiki Index
\`\`\`
${indexContent || '(Wiki is empty)'}
\`\`\`

Please analyze the content, extract only source-supported topics and relationships, and create or update Wiki pages only when each page's content is grounded in the current content.`,
            },
        ];

        const entities = await runIngestAgentLoop(settings, context, messages, onProgress);

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
