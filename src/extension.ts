import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('HemSoft Buddy');
  outputChannel.appendLine('HemSoft Buddy is now active.');

  context.subscriptions.push(
    vscode.commands.registerCommand('hs-buddy.helloWorld', () => {
      vscode.window.showInformationMessage('Hello from HemSoft Buddy!');
    })
  );
}

export function deactivate() {}
