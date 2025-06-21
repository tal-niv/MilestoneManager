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
        this.treeDataProvider = new MilestoneTreeDataProvider(this);
        this.initializeViews();
        this.updateStatusBar();
        this.setupBranchWatcher();
        // Register workspace folder change event
        this.context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.updateStatusBar();
            this.refreshTreeView();
            this.setupBranchWatcher();
        }));
    }
    initializeViews() {
        // Create tree view for activity bar
        vscode.window.createTreeView('milestoneView', {
            treeDataProvider: this.treeDataProvider
        });
        // Refresh the tree view to ensure it shows content
        this.treeDataProvider.refresh();
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
    async filterIgnoredFiles(workspacePath) {
        try {
            // Get the ignored files pattern
            const pattern = this.getIgnoredFilesPattern();
            console.log(`[DEBUG] Filtering with pattern: "${pattern}"`);
            if (!pattern.trim()) {
                console.log('No ignored files pattern configured, skipping file filtering');
                return;
            }
            // Create regex from pattern
            const regex = new RegExp(pattern);
            console.log(`[DEBUG] Created regex:`, regex);
            // Get list of staged files
            const { stdout: stagedFiles } = await execAsync('git diff --cached --name-only', { cwd: workspacePath });
            console.log(`[DEBUG] Staged files output: "${stagedFiles}"`);
            if (!stagedFiles.trim()) {
                console.log('No staged files to filter');
                return;
            }
            const fileList = stagedFiles.split('\n').map(f => f.trim()).filter(f => f);
            console.log(`[DEBUG] File list to check:`, fileList);
            // Filter files that match the ignore pattern
            const filesToRemove = fileList.filter(file => {
                const matches = regex.test(file);
                console.log(`[DEBUG] File "${file}" matches pattern: ${matches}`);
                return matches;
            });
            console.log(`[DEBUG] Files to remove:`, filesToRemove);
            // Remove matching files from staging
            for (const file of filesToRemove) {
                if (file.trim()) {
                    console.log(`Removing ignored file from staging: ${file}`);
                    await execAsync(`git reset -- "${file}"`, { cwd: workspacePath });
                }
            }
            if (filesToRemove.length > 0) {
                console.log(`Filtered ${filesToRemove.length} ignored files from milestone commit`);
            }
            else {
                console.log('[DEBUG] No files were filtered out');
            }
        }
        catch (error) {
            console.error('Error filtering ignored files:', error);
            // Don't throw - we don't want file filtering errors to break milestone creation
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
                // Add all files and then filter based on configured ignored files pattern
                await execAsync('git add .', { cwd: workspacePath });
                // Remove files matching the ignored files pattern
                await this.filterIgnoredFiles(workspacePath);
                // Create milestone commit
                await execAsync(`git commit --allow-empty -m "feat: ${note || 'No note provided'} saved as milestone"`, { cwd: workspacePath });
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
                this.refreshTreeView();
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
                this.refreshTreeView();
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
            const { stdout } = await execAsync(`git log origin/HEAD.. --pretty=format:"%H|||%s|||%ad|||%ai" --date=short --grep="^feat:.*saved as milestone" -n 50`, { cwd: workspacePath });
            if (!stdout.trim()) {
                return [];
            }
            return stdout
                .split('\n')
                .map(line => {
                const [hash, message, date, datetime] = line.split('|||');
                // Extract time from datetime (format: YYYY-MM-DD HH:MM:SS +TIMEZONE)
                const time = datetime.split(' ')[1];
                // Clean up the message for display: remove "feat: " prefix and " saved as milestone" suffix
                const cleanMessage = message.replace(/^feat:\s*/, '').replace(/\s*saved as milestone$/, '');
                return {
                    hash,
                    message: cleanMessage,
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
            const { stdout } = await execAsync(`git log origin/HEAD.. --grep="^feat:.*saved as milestone" -n 1`, { cwd: workspacePath });
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
                this.refreshTreeView();
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
                this.refreshTreeView();
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
    getIgnoredFilesPattern() {
        const config = vscode.workspace.getConfiguration('milestone-manager');
        const pattern = config.get('ignoredFilesPattern', '\\.(log|tmp)$|appsettings\\..*\\.json$');
        console.log('Reading ignored files pattern config:', {
            workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'none',
            pattern,
            configInspection: config.inspect('ignoredFilesPattern')
        });
        return pattern;
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
                // Refresh the tree view
                this.refreshTreeView();
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
    async configureIgnoredFiles() {
        try {
            const config = vscode.workspace.getConfiguration('milestone-manager');
            const currentValue = config.get('ignoredFilesPattern', '\\.(log|tmp)$|appsettings\\..*\\.json$');
            const newValue = await vscode.window.showInputBox({
                prompt: 'Enter regex pattern for files to exclude from milestone commits',
                placeHolder: '\\.(log|tmp)$|secrets\\.json$|node_modules/.*',
                value: currentValue,
                title: 'Configure Ignored Files Pattern',
                ignoreFocusOut: true,
                validateInput: (input) => {
                    try {
                        new RegExp(input);
                        return null; // Valid regex
                    }
                    catch (error) {
                        return 'Invalid regex pattern';
                    }
                }
            });
            if (newValue !== undefined) {
                // Try workspace settings first, fall back to global if it fails
                try {
                    await config.update('ignoredFilesPattern', newValue, vscode.ConfigurationTarget.Workspace);
                    vscode.window.showInformationMessage(`Ignored files pattern updated (workspace). Pattern: ${newValue}`);
                }
                catch (workspaceError) {
                    console.log('Failed to update workspace settings, trying global settings:', workspaceError);
                    try {
                        await config.update('ignoredFilesPattern', newValue, vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage(`Ignored files pattern updated (global). Pattern: ${newValue}`);
                    }
                    catch (globalError) {
                        throw new Error(`Unable to save settings to workspace or global configuration: ${globalError}`);
                    }
                }
                // Refresh the tree view
                this.refreshTreeView();
            }
        }
        catch (error) {
            console.error('Error configuring ignored files:', error);
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to update ignored files pattern: ${error.message}`);
            }
            else {
                vscode.window.showErrorMessage('Failed to update ignored files pattern: Unknown error');
            }
        }
    }
    async refresh() {
        try {
            console.log('Manual refresh triggered');
            // Force refresh both status bar and webview
            await this.updateStatusBar();
            this.refreshTreeView();
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
        this.refreshTreeView();
    }
    async refreshTreeView() {
        this.treeDataProvider.refresh();
    }
}
class MilestoneTreeDataProvider {
    constructor(milestoneManager) {
        this.milestoneManager = milestoneManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (!element) {
            // Root level items
            const items = [];
            // Configuration section
            const configItem = new MilestoneTreeItem('Configuration', vscode.TreeItemCollapsibleState.Expanded, 'config');
            configItem.iconPath = new vscode.ThemeIcon('settings-gear');
            items.push(configItem);
            // Actions section
            const actionsItem = new MilestoneTreeItem('Actions', vscode.TreeItemCollapsibleState.Expanded, 'actions');
            actionsItem.iconPath = new vscode.ThemeIcon('tools');
            items.push(actionsItem);
            // Milestones section
            const milestonesItem = new MilestoneTreeItem('Milestones', vscode.TreeItemCollapsibleState.Expanded, 'milestones');
            milestonesItem.iconPath = new vscode.ThemeIcon('milestone');
            items.push(milestonesItem);
            return items;
        }
        else {
            // Child items based on parent type
            switch (element.type) {
                case 'config':
                    return this.getConfigChildren();
                case 'actions':
                    return this.getActionChildren();
                case 'milestones':
                    return await this.getMilestoneChildren();
                default:
                    return [];
            }
        }
    }
    getConfigChildren() {
        const config = vscode.workspace.getConfiguration('milestone-manager');
        const additionalBranches = config.get('additionalBaseBranches', '');
        const baseBranches = this.milestoneManager.getBaseBranches();
        const items = [];
        // Configure base branches item
        const configItem = new MilestoneTreeItem('Configure Protected Branches', vscode.TreeItemCollapsibleState.None, 'configure-branches');
        configItem.command = {
            command: 'milestone-manager.configureBaseBranches',
            title: 'Configure Protected Branches'
        };
        configItem.iconPath = new vscode.ThemeIcon('edit');
        configItem.tooltip = `Current: ${baseBranches.join(', ')}`;
        items.push(configItem);
        // Show current protected branches
        const currentItem = new MilestoneTreeItem(`Protected: ${baseBranches.join(', ')}`, vscode.TreeItemCollapsibleState.None, 'current-branches');
        currentItem.iconPath = new vscode.ThemeIcon('shield');
        currentItem.tooltip = 'Currently protected base branches';
        items.push(currentItem);
        // Configure ignored files item
        const ignoredFilesPattern = this.milestoneManager.getIgnoredFilesPattern();
        const configIgnoreItem = new MilestoneTreeItem('Configure Ignored Files', vscode.TreeItemCollapsibleState.None, 'configure-ignored-files');
        configIgnoreItem.command = {
            command: 'milestone-manager.configureIgnoredFiles',
            title: 'Configure Ignored Files'
        };
        configIgnoreItem.iconPath = new vscode.ThemeIcon('file-symlink-file');
        configIgnoreItem.tooltip = `Current pattern: ${ignoredFilesPattern}`;
        items.push(configIgnoreItem);
        // Show current ignored files pattern
        const currentIgnoreItem = new MilestoneTreeItem(`Pattern: ${ignoredFilesPattern}`, vscode.TreeItemCollapsibleState.None, 'current-ignored-files');
        currentIgnoreItem.iconPath = new vscode.ThemeIcon('regex');
        currentIgnoreItem.tooltip = 'Current ignored files regex pattern';
        items.push(currentIgnoreItem);
        return items;
    }
    getActionChildren() {
        const items = [];
        // Create milestone action
        const createItem = new MilestoneTreeItem('Create Milestone', vscode.TreeItemCollapsibleState.None, 'create-milestone');
        createItem.command = {
            command: 'milestone-manager.createMilestone',
            title: 'Create Milestone'
        };
        createItem.iconPath = new vscode.ThemeIcon('add');
        items.push(createItem);
        // Refresh action
        const refreshItem = new MilestoneTreeItem('Refresh', vscode.TreeItemCollapsibleState.None, 'refresh');
        refreshItem.command = {
            command: 'milestone-manager.refresh',
            title: 'Refresh'
        };
        refreshItem.iconPath = new vscode.ThemeIcon('refresh');
        items.push(refreshItem);
        return items;
    }
    async getMilestoneChildren() {
        const milestones = await this.milestoneManager.getMilestones();
        if (milestones.length === 0) {
            const noMilestonesItem = new MilestoneTreeItem('No milestones yet', vscode.TreeItemCollapsibleState.None, 'no-milestones');
            noMilestonesItem.iconPath = new vscode.ThemeIcon('info');
            return [noMilestonesItem];
        }
        return milestones.map((milestone, index) => {
            const item = new MilestoneTreeItem(milestone.message, vscode.TreeItemCollapsibleState.None, 'milestone', milestone.hash);
            item.description = `${milestone.date} ${milestone.time} (${milestone.hash.substring(0, 7)})${index === 0 ? ' (Latest)' : ''}`;
            item.command = {
                command: 'milestone-manager.revertToMilestone',
                title: 'Revert to Milestone',
                arguments: [milestone.hash]
            };
            item.iconPath = new vscode.ThemeIcon('tag');
            item.tooltip = `Click to revert to this milestone\n${milestone.date} ${milestone.time}`;
            return item;
        });
    }
}
class MilestoneTreeItem extends vscode.TreeItem {
    constructor(label, collapsibleState, type, hash) {
        super(label, collapsibleState);
        this.label = label;
        this.collapsibleState = collapsibleState;
        this.type = type;
        this.hash = hash;
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
    context.subscriptions.push(vscode.commands.registerCommand('milestone-manager.configureIgnoredFiles', () => {
        milestoneManagerInstance?.configureIgnoredFiles();
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