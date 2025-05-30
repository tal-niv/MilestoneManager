import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execAsync = promisify(child_process.exec);

interface Milestone {
    hash: string;
    message: string;
    date: string;
    time: string;
}

class MilestoneManager {
    private statusBarItem: vscode.StatusBarItem;
    private gitHeadWatcher: fs.StatWatcher | null = null;
    private currentBranch: string | null = null;
    private treeDataProvider: MilestoneTreeDataProvider;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'milestone-manager.createMilestone';
        this.statusBarItem.text = '$(milestone)'; // Using milestone flag icon
        this.context.subscriptions.push(this.statusBarItem);
        
        this.treeDataProvider = new MilestoneTreeDataProvider(this);
        this.initializeViews();
        this.updateStatusBar();
        this.setupBranchWatcher();

        // Register workspace folder change event
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.updateStatusBar();
                this.refreshTreeView();
                this.setupBranchWatcher();
            })
        );
    }

    private initializeViews() {
        // Create tree view for activity bar
        vscode.window.createTreeView('milestoneView', {
            treeDataProvider: this.treeDataProvider
        });
        
        // Refresh the tree view to ensure it shows content
        this.treeDataProvider.refresh();
    }

    private getWorkspacePath(): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folder is opened');
        }
        return workspaceFolders[0].uri.fsPath;
    }

    private async isGitRepository(path: string): Promise<boolean> {
        try {
            await execAsync('git rev-parse --is-inside-work-tree', { cwd: path });
            return true;
        } catch {
            return false;
        }
    }

    private async updateStatusBar() {
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
            } else if (!hasAnyMilestones) {
                this.statusBarItem.text = '$(milestone) Create milestone';
                this.statusBarItem.tooltip = 'Click to create your first milestone';
            } else {
                this.statusBarItem.text = '$(milestone) Create milestone';
                this.statusBarItem.tooltip = 'Create new milestone';
            }

            this.statusBarItem.show();
        } catch (error) {
            console.error('Status bar update error:', error);
            this.statusBarItem.text = '$(milestone) Error';
            this.statusBarItem.tooltip = 'Error updating milestone status';
            this.statusBarItem.show();
        }
    }

    public async createMilestone() {
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
                } catch (pushError) {
                    // If push fails, try setting upstream
                    try {
                        await execAsync(`git push --set-upstream origin ${branchName.trim()}`, { cwd: workspacePath });
                    } catch (error) {
                        if (error instanceof Error) {
                            throw new Error(`Failed to push changes: ${error.message}`);
                        } else {
                            throw new Error('Failed to push changes: Unknown error');
                        }
                    }
                }
                
                vscode.window.showInformationMessage('Milestone created successfully!');
                this.updateStatusBar();
                this.refreshTreeView();
            } catch (error) {
                if (error instanceof Error) {
                    throw new Error(`Git operation failed: ${error.message}`);
                } else {
                    throw new Error('Git operation failed: Unknown error');
                }
            }
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to create milestone: ${error.message}`);
            } else {
                vscode.window.showErrorMessage('Failed to create milestone: Unknown error');
            }
        }
    }

    public async revertToMilestone(hash: string) {
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
                vscode.window.showErrorMessage(
                    `Cannot force push to base branch '${currentBranch}'. Protected branches: ${baseBranches.join(', ')}. Please switch to a different branch first.`
                );
                return;
            }

            // Confirm with the user
            const answer = await vscode.window.showWarningMessage(
                `Are you sure you want to reset ${currentBranch} to this milestone? This will restore the state exactly as it was at this milestone.`,
                { modal: true },
                'Yes, Reset'
            );

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
            } catch (error) {
                if (error instanceof Error) {
                    throw new Error(`Git operation failed: ${error.message}`);
                } else {
                    throw new Error('Git operation failed: Unknown error');
                }
            }
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to reset to milestone: ${error.message}`);
            } else {
                vscode.window.showErrorMessage('Failed to reset to milestone: Unknown error');
            }
        }
    }

    public async getMilestones(): Promise<Milestone[]> {
        try {
            const workspacePath = this.getWorkspacePath();
            
            // Get all milestone commits that are on the current branch but not on origin/HEAD
            // This shows only commits unique to the current branch
            const { stdout } = await execAsync(
                `git log origin/HEAD.. --pretty=format:"%H|||%s|||%ad|||%ai" --date=short --grep="^Milestone:" -n 50`, 
                { cwd: workspacePath }
            );

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
        } catch (error) {
            console.error('Error getting milestones:', error);
            return [];
        }
    }

    private async getCurrentMilestone(): Promise<string | null> {
        try {
            const milestones = await this.getMilestones();
            // Return the most recent milestone (first in the array) or null if none exist
            return milestones.length > 0 ? milestones[0].message : null;
        } catch (error) {
            console.error('Error getting current milestone:', error);
            return null;
        }
    }

    private async hasMilestones(): Promise<boolean> {
        const workspacePath = this.getWorkspacePath();
        try {
            // Check for milestone commits that are on the current branch but not on origin/HEAD
            const { stdout } = await execAsync(`git log origin/HEAD.. --grep="^Milestone:" -n 1`, { cwd: workspacePath });
            return !!stdout.trim();
        } catch (error) {
            console.error('Error checking for milestones:', error);
            return false;
        }
    }

    private setupBranchWatcher() {
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

        } catch (error) {
            console.error('Error setting up branch watcher:', error);
        }
    }

    private cleanupBranchWatcher() {
        if (this.gitHeadWatcher) {
            try {
                const workspacePath = this.getWorkspacePath();
                const gitHeadPath = path.join(workspacePath, '.git', 'HEAD');
                fs.unwatchFile(gitHeadPath);
                this.gitHeadWatcher = null;
            } catch (error) {
                // Ignore cleanup errors
                this.gitHeadWatcher = null;
            }
        }
    }

    private async updateCurrentBranch() {
        try {
            const workspacePath = this.getWorkspacePath();
            const { stdout: branchName } = await execAsync('git symbolic-ref --short HEAD', { cwd: workspacePath });
            this.currentBranch = branchName.trim();
            console.log('Initial current branch set to:', this.currentBranch);
        } catch (error) {
            this.currentBranch = null;
            console.log('Could not get initial branch, set to null:', error);
        }
    }

    private async handleBranchChange() {
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
            } else {
                console.log('Branch unchanged, no refresh needed');
            }
        } catch (error) {
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

    public getBaseBranches(): string[] {
        const hardcodedBranches = ['master', 'main'];
        const config = vscode.workspace.getConfiguration('milestone-manager');
        const additionalBranches = config.get<string>('additionalBaseBranches', '');
        
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

    public async configureBaseBranches() {
        try {
            const config = vscode.workspace.getConfiguration('milestone-manager');
            const currentValue = config.get<string>('additionalBaseBranches', '');
            
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
                    vscode.window.showInformationMessage(
                        `Base branches updated (workspace). Protected branches: ${baseBranches.join(', ')}`
                    );
                } catch (workspaceError) {
                    console.log('Failed to update workspace settings, trying global settings:', workspaceError);
                    try {
                        await config.update('additionalBaseBranches', newValue, vscode.ConfigurationTarget.Global);
                        const baseBranches = this.getBaseBranches();
                        vscode.window.showInformationMessage(
                            `Base branches updated (global). Protected branches: ${baseBranches.join(', ')}`
                        );
                    } catch (globalError) {
                        throw new Error(`Unable to save settings to workspace or global configuration: ${globalError}`);
                    }
                }
                
                // Refresh the tree view
                this.refreshTreeView();
            }
        } catch (error) {
            console.error('Error configuring base branches:', error);
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to update base branches: ${error.message}`);
            } else {
                vscode.window.showErrorMessage('Failed to update base branches: Unknown error');
            }
        }
    }

    public async refresh() {
        try {
            console.log('Manual refresh triggered');
            // Force refresh both status bar and webview
            await this.updateStatusBar();
            this.refreshTreeView();
            vscode.window.showInformationMessage('Milestones refreshed');
        } catch (error) {
            console.error('Error during manual refresh:', error);
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to refresh milestones: ${error.message}`);
            } else {
                vscode.window.showErrorMessage('Failed to refresh milestones: Unknown error');
            }
        }
    }

    public dispose() {
        this.cleanupBranchWatcher();
    }

    public showMilestones() {
        this.refreshTreeView();
    }

    private async refreshTreeView() {
        this.treeDataProvider.refresh();
    }
}

class MilestoneTreeDataProvider implements vscode.TreeDataProvider<MilestoneTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<MilestoneTreeItem | undefined | void> = new vscode.EventEmitter<MilestoneTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<MilestoneTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private milestoneManager: MilestoneManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: MilestoneTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: MilestoneTreeItem): Promise<MilestoneTreeItem[]> {
        if (!element) {
            // Root level items
            const items: MilestoneTreeItem[] = [];
            
            // Configuration section
            const configItem = new MilestoneTreeItem(
                'Configuration',
                vscode.TreeItemCollapsibleState.Expanded,
                'config'
            );
            configItem.iconPath = new vscode.ThemeIcon('settings-gear');
            items.push(configItem);

            // Actions section
            const actionsItem = new MilestoneTreeItem(
                'Actions',
                vscode.TreeItemCollapsibleState.Expanded,
                'actions'
            );
            actionsItem.iconPath = new vscode.ThemeIcon('tools');
            items.push(actionsItem);

            // Milestones section
            const milestonesItem = new MilestoneTreeItem(
                'Milestones',
                vscode.TreeItemCollapsibleState.Expanded,
                'milestones'
            );
            milestonesItem.iconPath = new vscode.ThemeIcon('milestone');
            items.push(milestonesItem);

            return items;
        } else {
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

    private getConfigChildren(): MilestoneTreeItem[] {
        const config = vscode.workspace.getConfiguration('milestone-manager');
        const additionalBranches = config.get<string>('additionalBaseBranches', '');
        const baseBranches = this.milestoneManager.getBaseBranches();

        const items: MilestoneTreeItem[] = [];
        
        // Configure base branches item
        const configItem = new MilestoneTreeItem(
            'Configure Protected Branches',
            vscode.TreeItemCollapsibleState.None,
            'configure-branches'
        );
        configItem.command = {
            command: 'milestone-manager.configureBaseBranches',
            title: 'Configure Protected Branches'
        };
        configItem.iconPath = new vscode.ThemeIcon('edit');
        configItem.tooltip = `Current: ${baseBranches.join(', ')}`;
        items.push(configItem);

        // Show current protected branches
        const currentItem = new MilestoneTreeItem(
            `Protected: ${baseBranches.join(', ')}`,
            vscode.TreeItemCollapsibleState.None,
            'current-branches'
        );
        currentItem.iconPath = new vscode.ThemeIcon('shield');
        currentItem.tooltip = 'Currently protected base branches';
        items.push(currentItem);

        return items;
    }

    private getActionChildren(): MilestoneTreeItem[] {
        const items: MilestoneTreeItem[] = [];

        // Create milestone action
        const createItem = new MilestoneTreeItem(
            'Create Milestone',
            vscode.TreeItemCollapsibleState.None,
            'create-milestone'
        );
        createItem.command = {
            command: 'milestone-manager.createMilestone',
            title: 'Create Milestone'
        };
        createItem.iconPath = new vscode.ThemeIcon('add');
        items.push(createItem);

        // Refresh action
        const refreshItem = new MilestoneTreeItem(
            'Refresh',
            vscode.TreeItemCollapsibleState.None,
            'refresh'
        );
        refreshItem.command = {
            command: 'milestone-manager.refresh',
            title: 'Refresh'
        };
        refreshItem.iconPath = new vscode.ThemeIcon('refresh');
        items.push(refreshItem);

        return items;
    }

    private async getMilestoneChildren(): Promise<MilestoneTreeItem[]> {
        const milestones = await this.milestoneManager.getMilestones();
        
        if (milestones.length === 0) {
            const noMilestonesItem = new MilestoneTreeItem(
                'No milestones yet',
                vscode.TreeItemCollapsibleState.None,
                'no-milestones'
            );
            noMilestonesItem.iconPath = new vscode.ThemeIcon('info');
            return [noMilestonesItem];
        }

        return milestones.map((milestone, index) => {
            const item = new MilestoneTreeItem(
                milestone.message,
                vscode.TreeItemCollapsibleState.None,
                'milestone',
                milestone.hash
            );
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
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: string,
        public readonly hash?: string
    ) {
        super(label, collapsibleState);
    }
}

let milestoneManagerInstance: MilestoneManager | null = null;

export function activate(context: vscode.ExtensionContext) {
    milestoneManagerInstance = new MilestoneManager(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('milestone-manager.createMilestone', () => {
            milestoneManagerInstance?.createMilestone();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('milestone-manager.revertToMilestone', (hash: string) => {
            milestoneManagerInstance?.revertToMilestone(hash);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('milestone-manager.configureBaseBranches', () => {
            milestoneManagerInstance?.configureBaseBranches();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('milestone-manager.refresh', () => {
            milestoneManagerInstance?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('milestone-manager.showMilestones', () => {
            milestoneManagerInstance?.showMilestones();
        })
    );
}

export function deactivate() {
    if (milestoneManagerInstance) {
        milestoneManagerInstance.dispose();
        milestoneManagerInstance = null;
    }
} 