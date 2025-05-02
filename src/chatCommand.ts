import * as vscode from 'vscode';

/**
 * Pattern to match milestone creation command in chat
 * Format: create milestone: <milestone_name>
 */
export const MILESTONE_CREATION_PATTERN = /^create milestone:\s*(.+)$/i;

/**
 * Register chat commands for milestone manager
 * @param context Extension context
 */
export function registerChatCommands(context: vscode.ExtensionContext) {
    // Register text processor for chat
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('milestone-manager', {
            provideTextDocumentContent(uri: vscode.Uri): string {
                return '';
            }
        })
    );

    // Register command to create milestone from chat
    context.subscriptions.push(
        vscode.commands.registerCommand('milestone-manager.chatCreateMilestone', async (milestoneName: string) => {
            try {
                // Execute the createMilestone command with the provided name
                await vscode.commands.executeCommand('milestone-manager.createMilestoneWithName', milestoneName);
                return `Milestone "${milestoneName}" created successfully!`;
            } catch (error) {
                if (error instanceof Error) {
                    return `Failed to create milestone: ${error.message}`;
                }
                return 'Failed to create milestone: Unknown error';
            }
        })
    );

    // Monitor command execution to intercept chat messages
    // This is a more reliable way to intercept chat commands in Cursor
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('type', async (textEditor, edit, args) => {
            // Only intercept in Cursor chat
            if (!textEditor || !textEditor.document.uri.scheme.includes('chat')) {
                return;
            }
            
            // Get the full line text where the cursor is
            const cursorPosition = textEditor.selection.active;
            const line = textEditor.document.lineAt(cursorPosition.line);
            const lineText = line.text;
            
            // Check if it's a milestone creation command
            const match = lineText.match(MILESTONE_CREATION_PATTERN);
            if (match) {
                const milestoneName = match[1].trim();
                
                // Wait a bit to let Cursor process the chat message
                setTimeout(async () => {
                    await vscode.commands.executeCommand('milestone-manager.chatCreateMilestone', milestoneName);
                }, 500);
            }
        })
    );
    
    // Register to process all text document changes to intercept chat messages
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (event) => {
            const document = event.document;
            
            // Only process Cursor chat documents
            if (!document.uri.scheme.includes('chat')) {
                return;
            }
            
            // Process each change
            for (const change of event.contentChanges) {
                const text = change.text;
                
                // Check if it matches the milestone creation pattern
                const match = text.match(MILESTONE_CREATION_PATTERN);
                if (match) {
                    const milestoneName = match[1].trim();
                    
                    // Wait a bit to let Cursor process the chat message
                    setTimeout(async () => {
                        await vscode.commands.executeCommand('milestone-manager.chatCreateMilestone', milestoneName);
                    }, 500);
                    
                    break; // Only process one matching command per change event
                }
            }
        })
    );
} 