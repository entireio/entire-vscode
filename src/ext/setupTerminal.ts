import * as vscode from 'vscode';

/** A command line for the Setup view to run, and where. */
export interface SetupRunRequest {
  /** The folder the command runs in. */
  cwd: string;
  /** The terminal's name, such as "Entire Setup". */
  terminalName: string;
  commandLine: string;
}

/** How a run ended, as far as the terminal can tell. */
export interface SetupRunResult {
  /**
   * The terminal reported when the command ended. Without shell integration
   * it cannot, and the command may still be running when this resolves.
   */
  tracked: boolean;
  exitCode?: number;
}

/**
 * Runs the Setup view's commands. Every command that sets something up runs
 * through this, in a terminal the user can see and type into. The
 * extension-host tests replace it, so that nothing is installed or enabled
 * for real.
 */
export interface SetupRunner {
  run(request: SetupRunRequest): Promise<SetupRunResult>;
}

/** How long to wait for a new terminal's shell integration before typing the command in. */
const SHELL_INTEGRATION_WAIT_MS = 5000;

/**
 * Runs each command in an integrated terminal named for the Setup view, one
 * terminal for each folder. The commands are interactive: `entire enable`
 * asks which agents to set up, `entire login` opens a browser, and
 * `entire brain setup` asks before it spends tokens.
 *
 * With shell integration, the terminal reports when the command ends and
 * with what exit code. Without it, the command is typed into the terminal,
 * and the caller learns nothing more.
 */
export class TerminalRunner implements SetupRunner, vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>();
  /** Terminals with a command under way, which a new command must not be typed into. */
  private readonly busy = new Set<vscode.Terminal>();
  private readonly subscription = vscode.window.onDidCloseTerminal((terminal) => {
    this.busy.delete(terminal);
    for (const [key, known] of this.terminals) {
      if (known === terminal) this.terminals.delete(key);
    }
  });

  dispose(): void {
    this.subscription.dispose();
  }

  async run(request: SetupRunRequest): Promise<SetupRunResult> {
    const terminal = this.terminalFor(request);
    terminal.show(false);
    const integration = await waitForShellIntegration(terminal, SHELL_INTEGRATION_WAIT_MS);
    if (!integration) {
      terminal.sendText(request.commandLine, true);
      return { tracked: false };
    }
    this.busy.add(terminal);
    const execution = integration.executeCommand(request.commandLine);
    return new Promise<SetupRunResult>((resolve) => {
      const finish = (result: SetupRunResult): void => {
        ended.dispose();
        closed.dispose();
        this.busy.delete(terminal);
        resolve(result);
      };
      const ended = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution !== execution) return;
        finish(event.exitCode === undefined ? { tracked: true } : { tracked: true, exitCode: event.exitCode });
      });
      // Closing the terminal ends the command with it.
      const closed = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) finish({ tracked: true });
      });
    });
  }

  /** The folder's terminal, or a new one when it has closed or is busy with another command. */
  private terminalFor(request: SetupRunRequest): vscode.Terminal {
    const known = this.terminals.get(request.cwd);
    if (known && known.exitStatus === undefined && !this.busy.has(known)) return known;
    const terminal = vscode.window.createTerminal({
      name: request.terminalName,
      cwd: request.cwd,
      iconPath: new vscode.ThemeIcon('tools'),
    });
    this.terminals.set(request.cwd, terminal);
    return terminal;
  }
}

/** The terminal's shell integration once it is active, or undefined after `timeoutMs`. */
function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(terminal.shellIntegration);
    }, timeoutMs);
    const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal !== terminal) return;
      clearTimeout(timer);
      subscription.dispose();
      resolve(event.shellIntegration);
    });
  });
}
