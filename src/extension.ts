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
    private milestoneList!: vscode.TreeView<any>;
    private treeDataProvider: MilestoneTreeDataProvider;
    private gitHeadWatcher: fs.StatWatcher | null = null;
    private currentBranch: string | null = null;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'milestone-manager.createMilestone';
        this.statusBarItem.text = '$(milestone)'; // Using milestone flag icon
        this.context.subscriptions.push(this.statusBarItem);
        
        this.treeDataProvider = new MilestoneTreeDataProvider(this);
        this.initializeMilestoneList();
        this.updateStatusBar();
        this.setupBranchWatcher();

        // Register workspace folder change event
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.updateStatusBar();
                this.treeDataProvider.refresh();
                this.setupBranchWatcher();
            })
        );
    }

    private initializeMilestoneList() {
        this.milestoneList = vscode.window.createTreeView('milestoneList', {
            treeDataProvider: this.treeDataProvider
        });
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
                this.treeDataProvider.refresh();
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

            // Check if branch is master or main
            const lowerBranch = currentBranch.toLowerCase();
            if (lowerBranch === 'master' || lowerBranch === 'main') {
                vscode.window.showErrorMessage('Cannot force push to master or main branch. Please switch to a different branch first.');
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
                this.treeDataProvider.refresh();
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
                this.treeDataProvider.refresh();
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
                this.treeDataProvider.refresh();
            }
        }
    }

    public dispose() {
        this.cleanupBranchWatcher();
    }
}

class MilestoneTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;
    private cachedMilestones: vscode.TreeItem[] | null = null;

    constructor(private milestoneManager: MilestoneManager) {}

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<vscode.TreeItem[]> {
        try {
            if (this.cachedMilestones) {
                return this.cachedMilestones;
            }

            const milestones = await this.milestoneManager.getMilestones();
            if (milestones.length === 0) {
                return [new vscode.TreeItem('No milestones yet')];
            }

            this.cachedMilestones = milestones.map((milestone, index) => {
                const item = new vscode.TreeItem(milestone.message);
                // Format: "YYYY-MM-DD HH:MM (abbreviated-hash)"
                const shortHash = milestone.hash.substring(0, 7);
                const label = index === 0 ? ' (Latest)' : '';
                item.description = `${milestone.date} ${milestone.time} (${shortHash})${label}`;
                item.tooltip = 
                    `${milestone.message}\n` +
                    `Created: ${milestone.date} ${milestone.time}\n` +
                    `Commit: ${milestone.hash}\n\n` +
                    `Click to revert to this milestone`;
                item.command = {
                    command: 'milestone-manager.revertToMilestone',
                    title: 'Revert to Milestone',
                    arguments: [milestone.hash]
                };
                return item;
            });

            return this.cachedMilestones;
        } catch (error) {
            console.error('Error getting milestones:', error);
            return [new vscode.TreeItem('Error loading milestones')];
        }
    }

    refresh(): void {
        this.cachedMilestones = null;
        this._onDidChangeTreeData.fire();
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
}

export function deactivate() {
    if (milestoneManagerInstance) {
        milestoneManagerInstance.dispose();
        milestoneManagerInstance = null;
    }
} 