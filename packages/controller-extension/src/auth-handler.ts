import * as vscode from 'vscode';

/**
 * Handles VS Code authentication session requests.
 * Intercepts auth flows before they become OS dialogs where possible.
 */
export class AuthHandler {
  private pendingAuthSessions = new Map<
    string,
    { resolve: (session: unknown) => void; reject: (err: Error) => void }
  >();

  register(): vscode.Disposable[] {
    return [
      // Listen for authentication session changes
      vscode.authentication.onDidChangeSessions((e) => {
        // Notify connected clients about auth changes
        // This will be broadcast through the WSServer
      }),
    ];
  }

  /**
   * Handle an authentication request for a given provider.
   * Attempts to use VS Code's built-in auth first, then falls back
   * to OS-level automation (handled by the orchestrator).
   */
  async handleAuth(
    provider: string,
    credentials: Record<string, string>
  ): Promise<{ status: string; provider: string }> {
    try {
      // Try to get an existing session first
      const session = await vscode.authentication.getSession(provider, [], {
        createIfNone: false,
      });

      if (session) {
        return {
          status: 'already_authenticated',
          provider,
        };
      }

      // Trigger session creation — this will show the auth UI
      // The orchestrator's OS automation layer will handle any dialogs
      const newSession = await vscode.authentication.getSession(
        provider,
        [],
        { createIfNone: true }
      );

      return {
        status: newSession ? 'authenticated' : 'cancelled',
        provider,
      };
    } catch (error) {
      return {
        status: 'error',
        provider,
      };
    }
  }

  /**
   * List available authentication providers.
   */
  getAvailableProviders(): string[] {
    // Common VS Code auth providers
    return ['microsoft', 'github'];
  }
}
