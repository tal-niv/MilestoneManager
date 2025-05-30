# Milestone Manager

A VS Code extension that helps you create and manage code milestones through git commits. This extension provides a seamless way to mark important points in your development process and easily revert to them when needed.

⚠️ **IMPORTANT**: This extension performs branch alterations and force pushes. It must be used on a dedicated feature branch - DO NOT use on master/main branches.

## Features

- **Milestone Creation**: Create named milestones at any point in your development process
- **Visual Management**: Dedicated activity bar view for managing all your milestones
- **Easy Navigation**: Quick access to all milestones through the sidebar
- **Git Integration**: Automatic git commit and tracking for each milestone
- **Revert Capability**: One-click reversion to any previous milestone
- **Visual Feedback**: Clear visual indicators for current and available milestones
- **Automatic Branch Detection**: Seamlessly refreshes milestone list when switching branches

## Installation

1. Open Visual Studio Code
2. Go to the Extensions view (Ctrl+Shift+X)
3. Search for "Milestone Manager"
4. Click Install
5. Reload VS Code when prompted

## Requirements

- Visual Studio Code ^1.85.0
- Git must be installed and configured on your system
- Your project must be initialized as a git repository
- A dedicated feature branch (NOT master/main) as the extension uses force push operations

## Usage

### Branch Setup
1. Create and checkout a dedicated feature branch for milestone management
2. Never use this extension on master/main branches
3. Ensure you have force push permissions on your branch

### Creating a Milestone
1. Click the Milestone Manager icon in the activity bar (looks like a milestone flag)
2. Click the "Create Milestone" button (+ icon) in the Milestones view
3. Enter a name and optional description for your milestone
   ⚠️ WARNING: Do not create milestones in folders containing secrets or sensitive files. Any files in git-tracked folders will be committed, which could accidentally expose sensitive information.
4. The extension will automatically:
   - Stage all current changes
   - Create a commit with your milestone information
   - Tag the commit for future reference

### Viewing Milestones
1. Open the Milestone Manager sidebar (click the milestone flag icon)
2. Browse through all your created milestones
3. Each milestone shows:
   - Milestone name
   - Creation date
   - Description (if provided)
   - Associated git commit

### Reverting to a Milestone
1. Find the desired milestone in the Milestones view
2. Click the "Revert to Milestone" button
3. Confirm the reversion
4. Your code will be restored to the exact state of that milestone

### Automatic Branch Switching
The extension automatically detects when you switch branches and refreshes the milestone list accordingly:

- **Seamless Detection**: Works with any method of branch switching:
  - VS Code Git extension
  - Command line
  - External Git tools
- **Silent Updates**: No notifications or interruptions - the milestone list simply updates
- **Instant Refresh**: Changes are detected immediately when you switch branches
- **Branch-Specific Milestones**: Each branch maintains its own set of milestones

This ensures you always see the correct milestones for your current branch without any manual intervention.

## Extension Commands

The extension provides the following commands:

- `milestone-manager.createMilestone`: Create a new milestone
- `milestone-manager.revertToMilestone`: Revert to a selected milestone

## Best Practices

1. Create milestones at significant development points:
   - After implementing major features
   - Before making significant changes
   - At stable, tested states of your code

2. Add descriptive names and notes to your milestones

3. Git Branch Management:
   - Always use a dedicated feature branch
   - Never create milestones on master/main branches (this is automatically blocked by the extension)
   - Inform team members about force push operations
   - ⚠️ Never create milestones in folders containing secrets or sensitive files - all git-tracked files will be committed

## Known Issues

None at the moment.

⚠️ **Git Operations Warning**: This extension performs force push operations and branch alterations. Make sure you understand the implications and have the necessary permissions.

## Release Notes

### 1.0.3

- **New Feature**: Automatic branch switching detection
- **Enhanced User Experience**: Milestone list automatically refreshes when switching branches using any method (CLI, VS Code Git extension, external tools)
- **Silent Operation**: Branch detection works seamlessly in the background without user intervention
- **Improved Performance**: Efficient file system watcher monitors git branch changes

### 1.0.2

- Improved implementation: Branch isolation now uses git's native branch filtering instead of commit message encoding
- Cleaner commit messages: Milestone commits now use simple "Milestone: [description]" format
- Enhanced performance: More efficient milestone filtering using git log with branch specification

### 1.0.1

- Fixed bug: Milestones are now isolated to specific branches
- Improved milestone tracking with branch-specific commit messages
- Enhanced milestone display in the milestones panel

### 1.0.0

Initial release of Milestone Manager with core features:
- Milestone creation and management
- Visual milestone browser
- Revert functionality
- Git integration

## Contributing

Found a bug or have a feature request? Please open an issue on our [GitHub repository](https://github.com/microsoft/vscode-extension-samples.git).

## License

This extension is licensed under the [MIT License](LICENSE). 