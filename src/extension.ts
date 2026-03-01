import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('HemSoft Buddy');
  outputChannel.appendLine('HemSoft Buddy is now active.');

  // Status bar item with custom icon
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(hs-buddy-icon) HemSoft Buddy';
  statusBarItem.tooltip = 'HemSoft Buddy - Copilot Sessions';
  statusBarItem.command = 'hs-buddy.showMenu';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Quick Pick menu command
  context.subscriptions.push(
    vscode.commands.registerCommand('hs-buddy.showMenu', async () => {
      const selection = await vscode.window.showQuickPick(
        [
          { label: '$(pulse) View Current Session', description: 'See active Copilot session details', id: 'currentSession' },
          { label: '$(history) Session History', description: 'Browse past sessions', id: 'sessionHistory' },
          { label: '$(export) Export Session Data', description: 'Export sessions to file', id: 'export' },
          { label: '$(gear) Settings', description: 'Configure HemSoft Buddy', id: 'settings' },
        ],
        { placeHolder: 'HemSoft Buddy - Copilot Sessions' }
      );

      if (selection) {
        switch (selection.id) {
          case 'currentSession':
            vscode.window.showInformationMessage('Copilot Session tracking coming soon!');
            break;
          case 'sessionHistory':
            vscode.window.showInformationMessage('Session History coming soon!');
            break;
          case 'export':
            vscode.window.showInformationMessage('Export coming soon!');
            break;
          case 'settings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'hsBuddy');
            break;
        }
      }
    })
  );

  // Keep hello world for verification
  context.subscriptions.push(
    vscode.commands.registerCommand('hs-buddy.helloWorld', () => {
      vscode.window.showInformationMessage('Hello from HemSoft Buddy!');
    })
  );
}

export function deactivate() {}
