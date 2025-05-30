"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process.exec);
class MilestoneManager {
    constructor(context) {
        this.context = context;
        this.gitHeadWatcher = null;
        this.currentBranch = null;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'milestone-manager.createMilestone';
        this.statusBarItem.text = '$(milestone)'; // Using milestone flag icon
        this.context.subscriptions.push(this.statusBarItem);
        this.treeDataProvider = new MilestoneTreeDataProvider();
        this.initializeViews();
        this.updateStatusBar();
        this.setupBranchWatcher();
        // Register workspace folder change event
        this.context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.updateStatusBar();
            this.updateWebview();
            this.setupBranchWatcher();
        }));
    }
    initializeViews() {
        // Create tree view for activity bar
        vscode.window.createTreeView('milestoneView', {
            treeDataProvider: this.treeDataProvider
        });
    }
    initializeMilestoneView() {
        // Create webview panel
        this.webviewPanel = vscode.window.createWebviewPanel('milestoneManager', 'Milestones', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        this.webviewPanel.onDidDispose(() => {
            this.webviewPanel = undefined;
        });
        // Handle messages from webview
        this.webviewPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'updateBaseBranches':
                    await this.updateBaseBranchesFromWebview(message.value);
                    break;
                case 'createMilestone':
                    await this.createMilestone();
                    break;
                case 'revertToMilestone':
                    await this.revertToMilestone(message.hash);
                    break;
                case 'refresh':
                    await this.refresh();
                    break;
            }
        });
        this.updateWebview();
    }
    getWorkspacePath() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folder is opened');
        }
        return workspaceFolders[0].uri.fsPath;
    }
    async isGitRepository(path) {
        try {
            await execAsync('git rev-parse --is-inside-work-tree', { cwd: path });
            return true;
        }
        catch {
            return false;
        }
    }
    async updateStatusBar() {
        try {
            const workspacePath = this.getWorkspacePath();
            if (!await this.isGitRepository(workspacePath)) {
                this.statusBarItem.text = '$(milestone) Not a git repository';
                this.statusBarItem.show();
                return;
            }
            const milestoneInfo = await this.getCurrentMilestone();
            const hasAnyMilestones = await this.hasMilestones();
            if (milestoneInfo) {
                this.statusBarItem.text = `$(milestone) ${milestoneInfo}`;
                this.statusBarItem.tooltip = 'Create milestone';
            }
            else if (!hasAnyMilestones) {
                this.statusBarItem.text = '$(milestone) Create milestone';
                this.statusBarItem.tooltip = 'Click to create your first milestone';
            }
            else {
                this.statusBarItem.text = '$(milestone) Create milestone';
                this.statusBarItem.tooltip = 'Create new milestone';
            }
            this.statusBarItem.show();
        }
        catch (error) {
            console.error('Status bar update error:', error);
            this.statusBarItem.text = '$(milestone) Error';
            this.statusBarItem.tooltip = 'Error updating milestone status';
            this.statusBarItem.show();
        }
    }
    async createMilestone() {
        try {
            const workspacePath = this.getWorkspacePath();
            if (!await this.isGitRepository(workspacePath)) {
                vscode.window.showErrorMessage('This workspace is not a git repository');
                return;
            }
            const note = await vscode.window.showInputBox({
                prompt: 'Enter an optional note for this milestone',
                placeHolder: 'Milestone note'
            });
            if (note === undefined) {
                return; // User cancelled
            }
            // Get current branch name
            const { stdout: branchName } = await execAsync('git symbolic-ref --short HEAD', { cwd: workspacePath });
            try {
                // Add all new files to git except .log and appsettings.*json files
                await execAsync('git add .', { cwd: workspacePath });
                // Remove any .log files that might have been added
                await execAsync('git reset -- "*.log"', { cwd: workspacePath });
                // Remove any appsettings.*json files that might have been added
                await execAsync('git reset -- "appsettings.*json"', { cwd: workspacePath });
                // Create milestone commit
                await execAsync(`git commit --allow-empty -m "Milestone: ${note || 'No note provided'}"`, { cwd: workspacePath });
                // Try to push
                try {
                    await execAsync('git push', { cwd: workspacePath });
                }
                catch (pushError) {
                    // If push fails, try setting upstream
                    try {
                        await execAsync(`git push --set-upstream origin ${branchName.trim()}`, { cwd: workspacePath });
                    }
                    catch (error) {
                        if (error instanceof Error) {
                            throw new Error(`Failed to push changes: ${error.message}`);
                        }
                        else {
                            throw new Error('Failed to push changes: Unknown error');
                        }
                    }
                }
                vscode.window.showInformationMessage('Milestone created successfully!');
                this.updateStatusBar();
                this.updateWebview();
            }
            catch (error) {
                if (error instanceof Error) {
                    throw new Error(`Git operation failed: ${error.message}`);
                }
                else {
                    throw new Error('Git operation failed: Unknown error');
                }
            }
        }
        catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to create milestone: ${error.message}`);
            }
            else {
                vscode.window.showErrorMessage('Failed to create milestone: Unknown error');
            }
        }
    }
    async revertToMilestone(hash) {
        try {
            const workspacePath = this.getWorkspacePath();
            if (!await this.isGitRepository(workspacePath)) {
                vscode.window.showErrorMessage('This workspace is not a git repository');
                return;
            }
            // Get current branch name
            const { stdout: branchName } = await execAsync('git symbolic-ref --short HEAD', { cwd: workspacePath });
            const currentBranch = branchName.trim();
            // Check if branch is a protected base branch
            const baseBranches = this.getBaseBranches();
            const lowerBranch = currentBranch.toLowerCase();
            const isBaseBranch = baseBranches.some(branch => branch.toLowerCase() === lowerBranch);
            if (isBaseBranch) {
                vscode.window.showErrorMessage(`Cannot force push to base branch '${currentBranch}'. Protected branches: ${baseBranches.join(', ')}. Please switch to a different branch first.`);
                return;
            }
            // Confirm with the user
            const answer = await vscode.window.showWarningMessage(`Are you sure you want to reset ${currentBranch} to this milestone? This will restore the state exactly as it was at this milestone.`, { modal: true }, 'Yes, Reset');
            if (answer !== 'Yes, Reset') {
                return;
            }
            try {
                // Add any modified files to make sure they're tracked
                await execAsync('git add -A', { cwd: workspacePath });
                // Reset the index and working directory to the milestone
                await execAsync(`git reset --hard ${hash}`, { cwd: workspacePath });
                // Clean up any untracked files
                await execAsync('git clean -fd', { cwd: workspacePath });
                // Force push to update remote
                await execAsync(`git push -f origin ${currentBranch}`, { cwd: workspacePath });
                vscode.window.showInformationMessage(`Successfully reset to milestone and updated remote`);
                this.updateStatusBar();
                this.updateWebview();
            }
            catch (error) {
                if (error instanceof Error) {
                    throw new Error(`Git operation failed: ${error.message}`);
                }
                else {
                    throw new Error('Git operation failed: Unknown error');
                }
            }
        }
        catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to reset to milestone: ${error.message}`);
            }
            else {
                vscode.window.showErrorMessage('Failed to reset to milestone: Unknown error');
            }
        }
    }
    async getMilestones() {
        try {
            const workspacePath = this.getWorkspacePath();
            // Get all milestone commits that are on the current branch but not on origin/HEAD
            // This shows only commits unique to the current branch
            const { stdout } = await execAsync(`git log origin/HEAD.. --pretty=format:"%H|||%s|||%ad|||%ai" --date=short --grep="^Milestone:" -n 50`, { cwd: workspacePath });
            if (!stdout.trim()) {
                return [];
            }
            return stdout
                .split('\n')
                .map(line => {
                const [hash, message, date, datetime] = line.split('|||');
                // Extract time from datetime (format: YYYY-MM-DD HH:MM:SS +TIMEZONE)
                const time = datetime.split(' ')[1];
                return {
                    hash,
                    message,
                    date,
                    time
                };
            });
        }
        catch (error) {
            console.error('Error getting milestones:', error);
            return [];
        }
    }
    async getCurrentMilestone() {
        try {
            const milestones = await this.getMilestones();
            // Return the most recent milestone (first in the array) or null if none exist
            return milestones.length > 0 ? milestones[0].message : null;
        }
        catch (error) {
            console.error('Error getting current milestone:', error);
            return null;
        }
    }
    async hasMilestones() {
        const workspacePath = this.getWorkspacePath();
        try {
            // Check for milestone commits that are on the current branch but not on origin/HEAD
            const { stdout } = await execAsync(`git log origin/HEAD.. --grep="^Milestone:" -n 1`, { cwd: workspacePath });
            return !!stdout.trim();
        }
        catch (error) {
            console.error('Error checking for milestones:', error);
            return false;
        }
    }
    setupBranchWatcher() {
        // Clean up existing watcher
        this.cleanupBranchWatcher();
        try {
            const workspacePath = this.getWorkspacePath();
            const gitHeadPath = path.join(workspacePath, '.git', 'HEAD');
            console.log('Setting up branch watcher for:', gitHeadPath);
            // Check if .git/HEAD exists
            if (!fs.existsSync(gitHeadPath)) {
                console.log('Git HEAD file does not exist:', gitHeadPath);
                return;
            }
            // Get initial branch name
            this.updateCurrentBranch();
            // Watch .git/HEAD for changes
            this.gitHeadWatcher = fs.watchFile(gitHeadPath, { interval: 1000 }, async (curr, prev) => {
                console.log('Git HEAD file changed - curr:', curr.mtime, 'prev:', prev.mtime);
                await this.handleBranchChange();
            });
            console.log('Branch watcher setup complete');
        }
        catch (error) {
            console.error('Error setting up branch watcher:', error);
        }
    }
    cleanupBranchWatcher() {
        if (this.gitHeadWatcher) {
            try {
                const workspacePath = this.getWorkspacePath();
                const gitHeadPath = path.join(workspacePath, '.git', 'HEAD');
                fs.unwatchFile(gitHeadPath);
                this.gitHeadWatcher = null;
            }
            catch (error) {
                // Ignore cleanup errors
                this.gitHeadWatcher = null;
            }
        }
    }
    async updateCurrentBranch() {
        try {
            const workspacePath = this.getWorkspacePath();
            const { stdout: branchName } = await execAsync('git symbolic-ref --short HEAD', { cwd: workspacePath });
            this.currentBranch = branchName.trim();
            console.log('Initial current branch set to:', this.currentBranch);
        }
        catch (error) {
            this.currentBranch = null;
            console.log('Could not get initial branch, set to null:', error);
        }
    }
    async handleBranchChange() {
        try {
            const workspacePath = this.getWorkspacePath();
            const { stdout: branchName } = await execAsync('git symbolic-ref --short HEAD', { cwd: workspacePath });
            const newBranch = branchName.trim();
            console.log('handleBranchChange - current:', this.currentBranch, 'new:', newBranch);
            // Only refresh if branch actually changed
            if (this.currentBranch !== newBranch) {
                console.log('Branch changed from', this.currentBranch, 'to', newBranch, '- refreshing milestone data');
                this.currentBranch = newBranch;
                // Silently refresh milestone data
                this.updateStatusBar();
                this.updateWebview();
            }
            else {
                console.log('Branch unchanged, no refresh needed');
            }
        }
        catch (error) {
            console.log('handleBranchChange error (possibly detached HEAD):', error);
            // Branch might be in detached HEAD state or other git states
            // Just update current branch to null and refresh
            if (this.currentBranch !== null) {
                console.log('Setting current branch to null and refreshing');
                this.currentBranch = null;
                this.updateStatusBar();
                this.updateWebview();
            }
        }
    }
    getBaseBranches() {
        const hardcodedBranches = ['master', 'main'];
        const config = vscode.workspace.getConfiguration('milestone-manager');
        const additionalBranches = config.get('additionalBaseBranches', '');
        console.log('Reading base branches config:', {
            workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'none',
            additionalBranches,
            configInspection: config.inspect('additionalBaseBranches')
        });
        if (additionalBranches.trim()) {
            const configuredBranches = additionalBranches
                .split(';')
                .map(branch => branch.trim())
                .filter(branch => branch.length > 0);
            return [...hardcodedBranches, ...configuredBranches];
        }
        return hardcodedBranches;
    }
    async configureBaseBranches() {
        try {
            const config = vscode.workspace.getConfiguration('milestone-manager');
            const currentValue = config.get('additionalBaseBranches', '');
            const newValue = await vscode.window.showInputBox({
                prompt: 'Enter additional base branches that cannot be force pushed to (separated by semicolons)',
                placeHolder: 'develop;staging;release',
                value: currentValue,
                title: 'Configure Protected Base Branches',
                ignoreFocusOut: true
            });
            if (newValue !== undefined) {
                // Try workspace settings first, fall back to global if it fails
                try {
                    await config.update('additionalBaseBranches', newValue, vscode.ConfigurationTarget.Workspace);
                    const baseBranches = this.getBaseBranches();
                    vscode.window.showInformationMessage(`Base branches updated (workspace). Protected branches: ${baseBranches.join(', ')}`);
                }
                catch (workspaceError) {
                    console.log('Failed to update workspace settings, trying global settings:', workspaceError);
                    try {
                        await config.update('additionalBaseBranches', newValue, vscode.ConfigurationTarget.Global);
                        const baseBranches = this.getBaseBranches();
                        vscode.window.showInformationMessage(`Base branches updated (global). Protected branches: ${baseBranches.join(', ')}`);
                    }
                    catch (globalError) {
                        throw new Error(`Unable to save settings to workspace or global configuration: ${globalError}`);
                    }
                }
            }
        }
        catch (error) {
            console.error('Error configuring base branches:', error);
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to update base branches: ${error.message}`);
            }
            else {
                vscode.window.showErrorMessage('Failed to update base branches: Unknown error');
            }
        }
    }
    async refresh() {
        try {
            console.log('Manual refresh triggered');
            // Force refresh both status bar and webview
            await this.updateStatusBar();
            this.updateWebview();
            vscode.window.showInformationMessage('Milestones refreshed');
        }
        catch (error) {
            console.error('Error during manual refresh:', error);
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to refresh milestones: ${error.message}`);
            }
            else {
                vscode.window.showErrorMessage('Failed to refresh milestones: Unknown error');
            }
        }
    }
    dispose() {
        this.cleanupBranchWatcher();
    }
    showMilestones() {
        if (!this.webviewPanel) {
            this.initializeMilestoneView();
        }
        else {
            this.webviewPanel.reveal();
        }
    }
    async updateWebview() {
        if (!this.webviewPanel) {
            return;
        }
        const config = vscode.workspace.getConfiguration('milestone-manager');
        const additionalBranches = config.get('additionalBaseBranches', '');
        const baseBranches = this.getBaseBranches();
        const milestones = await this.getMilestones();
        this.webviewPanel.webview.html = this.getWebviewContent(additionalBranches, baseBranches, milestones);
    }
    async updateBaseBranchesFromWebview(newValue) {
        try {
            const config = vscode.workspace.getConfiguration('milestone-manager');
            // Try workspace settings first, fall back to global if it fails
            try {
                await config.update('additionalBaseBranches', newValue, vscode.ConfigurationTarget.Workspace);
                const baseBranches = this.getBaseBranches();
                vscode.window.showInformationMessage(`Base branches updated (workspace). Protected branches: ${baseBranches.join(', ')}`);
            }
            catch (workspaceError) {
                console.log('Failed to update workspace settings, trying global settings:', workspaceError);
                try {
                    await config.update('additionalBaseBranches', newValue, vscode.ConfigurationTarget.Global);
                    const baseBranches = this.getBaseBranches();
                    vscode.window.showInformationMessage(`Base branches updated (global). Protected branches: ${baseBranches.join(', ')}`);
                }
                catch (globalError) {
                    throw new Error(`Unable to save settings to workspace or global configuration: ${globalError}`);
                }
            }
            // Refresh the webview
            this.updateWebview();
        }
        catch (error) {
            console.error('Error updating base branches from webview:', error);
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to update base branches: ${error.message}`);
            }
            else {
                vscode.window.showErrorMessage('Failed to update base branches: Unknown error');
            }
        }
    }
    getWebviewContent(additionalBranches, baseBranches, milestones) {
        return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Milestone Manager</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 10px;
                    margin: 0;
                }
                .settings-section {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 15px;
                    margin-bottom: 15px;
                }
                .settings-label {
                    font-weight: bold;
                    margin-bottom: 5px;
                    display: block;
                }
                .settings-input {
                    width: 100%;
                    padding: 5px;
                    border: 1px solid var(--vscode-input-border);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border-radius: 3px;
                    margin-bottom: 5px;
                }
                .settings-help {
                    font-size: 0.9em;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 5px;
                }
                .protected-branches {
                    font-size: 0.9em;
                    color: var(--vscode-textLink-foreground);
                    margin-top: 5px;
                }
                .milestone-actions {
                    margin-bottom: 10px;
                }
                .action-button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    margin-right: 5px;
                    border-radius: 3px;
                    cursor: pointer;
                    font-size: 12px;
                }
                .action-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .milestone-list {
                    list-style: none;
                    padding: 0;
                    margin: 0;
                }
                .milestone-item {
                    padding: 8px;
                    border: 1px solid var(--vscode-panel-border);
                    margin-bottom: 2px;
                    cursor: pointer;
                    border-radius: 3px;
                }
                .milestone-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .milestone-title {
                    font-weight: bold;
                    margin-bottom: 2px;
                }
                .milestone-details {
                    font-size: 0.9em;
                    color: var(--vscode-descriptionForeground);
                }
                .no-milestones {
                    text-align: center;
                    padding: 20px;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }
            </style>
        </head>
        <body>
            <div class="settings-section">
                <label class="settings-label">Protected Base Branches</label>
                <input type="text" id="baseBranchesInput" class="settings-input" 
                       value="${additionalBranches}" 
                       placeholder="develop;staging;release"
                       title="Enter additional base branches separated by semicolons">
                <div class="settings-help">
                    Additional branches that cannot be force pushed to (separated by semicolons)
                </div>
                <div class="protected-branches">
                    Currently protected: ${baseBranches.join(', ')}
                </div>
            </div>

            <div class="milestone-actions">
                <button class="action-button" onclick="createMilestone()">➕ Create Milestone</button>
                <button class="action-button" onclick="refresh()">🔄 Refresh</button>
            </div>

            <div id="milestonesList">
                ${milestones.length === 0 ?
            '<div class="no-milestones">No milestones yet</div>' :
            `<ul class="milestone-list">
                        ${milestones.map((milestone, index) => `
                            <li class="milestone-item" onclick="revertToMilestone('${milestone.hash}')">
                                <div class="milestone-title">${milestone.message}</div>
                                <div class="milestone-details">
                                    ${milestone.date} ${milestone.time} (${milestone.hash.substring(0, 7)})${index === 0 ? ' (Latest)' : ''}
                                </div>
                            </li>
                        `).join('')}
                    </ul>`}
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                const baseBranchesInput = document.getElementById('baseBranchesInput');
                
                // Save base branches when Enter is pressed
                baseBranchesInput.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') {
                        console.log('Enter pressed, saving base branches:', e.target.value);
                        vscode.postMessage({
                            command: 'updateBaseBranches',
                            value: e.target.value
                        });
                    }
                });

                // Save base branches when input loses focus
                baseBranchesInput.addEventListener('blur', function(e) {
                    console.log('Input lost focus, saving base branches:', e.target.value);
                    vscode.postMessage({
                        command: 'updateBaseBranches',
                        value: e.target.value
                    });
                });

                function createMilestone() {
                    vscode.postMessage({ command: 'createMilestone' });
                }

                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }

                function revertToMilestone(hash) {
                    vscode.postMessage({ 
                        command: 'revertToMilestone',
                        hash: hash 
                    });
                }
            </script>
        </body>
        </html>
        `;
    }
}
class MilestoneTreeDataProvider {
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        const openItem = new vscode.TreeItem('Open Milestone Manager');
        openItem.command = {
            command: 'milestone-manager.showMilestones',
            title: 'Open Milestone Manager'
        };
        openItem.iconPath = new vscode.ThemeIcon('milestone');
        openItem.tooltip = 'Click to open the milestone management interface';
        return [openItem];
    }
}
let milestoneManagerInstance = null;
function activate(context) {
    milestoneManagerInstance = new MilestoneManager(context);
    context.subscriptions.push(vscode.commands.registerCommand('milestone-manager.createMilestone', () => {
        milestoneManagerInstance?.createMilestone();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('milestone-manager.revertToMilestone', (hash) => {
        milestoneManagerInstance?.revertToMilestone(hash);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('milestone-manager.configureBaseBranches', () => {
        milestoneManagerInstance?.configureBaseBranches();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('milestone-manager.refresh', () => {
        milestoneManagerInstance?.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('milestone-manager.showMilestones', () => {
        milestoneManagerInstance?.showMilestones();
    }));
}
function deactivate() {
    if (milestoneManagerInstance) {
        milestoneManagerInstance.dispose();
        milestoneManagerInstance = null;
    }
}
//# sourceMappingURL=extension.js.map