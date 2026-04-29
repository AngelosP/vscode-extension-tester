import * as vscode from 'vscode';

interface QuickInputItemInfo {
  id: string;
  label: string;
  matchLabel: string;
  description?: string;
  detail?: string;
  kind?: 'item' | 'separator';
  picked?: boolean;
  alwaysShow?: boolean;
  buttons?: string[];
}

interface QuickInputState {
  active: boolean;
  id?: string;
  kind?: 'quickPick' | 'inputBox';
  source?: 'showQuickPick' | 'createQuickPick' | 'showInputBox' | 'createInputBox';
  title?: string;
  placeholder?: string;
  prompt?: string;
  value?: string;
  validationMessage?: string;
  busy?: boolean;
  enabled?: boolean;
  canSelectMany?: boolean;
  items?: QuickInputItemInfo[];
  activeItems?: QuickInputItemInfo[];
  selectedItems?: QuickInputItemInfo[];
  createdAt?: number;
  updatedAt?: number;
}

interface TrackedQuickInputItem {
  id: string;
  raw: unknown;
  info: QuickInputItemInfo;
}

interface QuickInputSession {
  id: string;
  kind: 'quickPick' | 'inputBox';
  source: 'showQuickPick' | 'createQuickPick' | 'showInputBox' | 'createInputBox';
  createdAt: number;
  updatedAt: number;
  title?: string;
  placeholder?: string;
  prompt?: string;
  value?: string;
  validationMessage?: string;
  busy?: boolean;
  enabled?: boolean;
  canSelectMany?: boolean;
  items: TrackedQuickInputItem[];
  activeItems: TrackedQuickInputItem[];
  selectedItems: TrackedQuickInputItem[];
  handle?: vscode.QuickPick<vscode.QuickPickItem> | vscode.InputBox;
  inputOptions?: vscode.InputBoxOptions;
  quickPickOptions?: vscode.QuickPickOptions;
  resolve?: (value: unknown) => void;
  reject?: (error: unknown) => void;
  completed?: boolean;
  disposables: vscode.Disposable[];
}

/**
 * Intercepts VS Code QuickInput APIs so tests can inspect and drive the same
 * model the extension under test is using, instead of guessing through the DOM.
 */
export class UIInterceptor {
  private sessionCounter = 0;
  private activeSession?: QuickInputSession;
  private pendingDialogResolve: ((button: string) => void) | undefined;

  register(): vscode.Disposable[] {
    const originalShowQuickPick = vscode.window.showQuickPick;
    const originalCreateQuickPick = vscode.window.createQuickPick;
    const originalShowInputBox = vscode.window.showInputBox;
    const originalCreateInputBox = vscode.window.createInputBox;

    (vscode.window as any).showQuickPick = <T extends vscode.QuickPickItem>(
      items: readonly T[] | Thenable<readonly T[]>,
      options?: vscode.QuickPickOptions,
      token?: vscode.CancellationToken,
    ) => this.interceptShowQuickPick(originalShowQuickPick, items, options, token);

    (vscode.window as any).createQuickPick = <T extends vscode.QuickPickItem>() =>
      this.interceptCreateQuickPick<T>(originalCreateQuickPick);

    (vscode.window as any).showInputBox = (
      options?: vscode.InputBoxOptions,
      token?: vscode.CancellationToken,
    ) => this.interceptShowInputBox(originalShowInputBox, options, token);

    (vscode.window as any).createInputBox = () =>
      this.interceptCreateInputBox(originalCreateInputBox);

    return [{
      dispose: () => {
        (vscode.window as any).showQuickPick = originalShowQuickPick;
        (vscode.window as any).createQuickPick = originalCreateQuickPick;
        (vscode.window as any).showInputBox = originalShowInputBox;
        (vscode.window as any).createInputBox = originalCreateInputBox;
      },
    }];
  }

  getQuickInputState(): QuickInputState {
    const session = this.activeSession;
    if (!session) return { active: false };
    return this.snapshot(session);
  }

  clearQuickInput(): void {
    const session = this.activeSession;
    if (!session) return;
    session.completed = true;
    if (session.resolve) session.resolve(undefined);
    try { session.handle?.hide(); } catch { /* best effort */ }
    this.disposeSession(session);
    this.activeSession = undefined;
  }

  getLastQuickPickItems(): string[] {
    const state = this.getQuickInputState();
    return state.items?.map((item) => item.label) ?? [];
  }

  getLastInputBoxPrompt(): string {
    const state = this.getQuickInputState();
    return state.prompt ?? '';
  }

  async selectQuickInputItem(target: string): Promise<{ selected: string | string[]; intercepted: boolean }> {
    const session = this.activeSession;
    if (!session || session.kind !== 'quickPick') {
      throw new Error('No QuickPick is currently active');
    }

    const item = this.findSelectableItem(session, target);
    session.activeItems = [item];
    session.selectedItems = session.canSelectMany ? [...session.selectedItems.filter((i) => i.id !== item.id), item] : [item];
    session.updatedAt = Date.now();

    if (session.handle && isQuickPickHandle(session.handle)) {
      session.handle.activeItems = [item.raw as vscode.QuickPickItem];
      session.handle.selectedItems = session.selectedItems.map((selected) => selected.raw as vscode.QuickPickItem);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return { selected: this.selectedLabels(session), intercepted: true };
    }

    session.completed = true;
    const value = session.canSelectMany
      ? session.selectedItems.map((selected) => selected.raw)
      : item.raw;
    this.invokeShowQuickPickSelectItem(session, item.raw);
    if (session.resolve) session.resolve(value);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    this.disposeSession(session);
    if (this.activeSession?.id === session.id) this.activeSession = undefined;
    return { selected: this.selectedLabels(session), intercepted: true };
  }

  async submitQuickInputText(value: string): Promise<{ entered: string; intercepted: boolean; accepted?: boolean; validationMessage?: string }> {
    const session = this.activeSession;
    if (!session || session.kind !== 'inputBox') {
      return { entered: value, intercepted: false };
    }

    session.value = value;
    session.updatedAt = Date.now();

    if (session.handle && isInputBoxHandle(session.handle)) {
      session.handle.value = value;
      this.syncInputBoxFromHandle(session, session.handle);
      const validationMessage = await this.waitForInputBoxValidation(session, session.handle);
      if (validationMessage) {
        return { entered: value, intercepted: true, accepted: false, validationMessage };
      }
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return { entered: value, intercepted: true, accepted: true };
    }

    const validationMessage = await this.validateShowInputBox(session, value);
    if (validationMessage) {
      session.validationMessage = validationMessage;
      session.updatedAt = Date.now();
      return { entered: value, intercepted: true, accepted: false, validationMessage };
    }

    session.completed = true;
    if (session.resolve) session.resolve(value);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    this.disposeSession(session);
    if (this.activeSession?.id === session.id) this.activeSession = undefined;
    return { entered: value, intercepted: true, accepted: true };
  }

  async respondToQuickPick(label: string): Promise<{ selected: string }> {
    try {
      const result = await this.selectQuickInputItem(label);
      return { selected: Array.isArray(result.selected) ? result.selected.join(', ') : result.selected };
    } catch (err) {
      if (!isLegacyQuickPickFallbackError(err)) throw err;
    }

    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('type', { text: label });
    await delay(200);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    return { selected: label };
  }

  async respondToInputBox(value: string): Promise<{ entered: string; intercepted?: boolean }> {
    const result = await this.submitQuickInputText(value);
    return { entered: value, intercepted: result.intercepted };
  }

  async respondToDialog(button: string): Promise<{ clicked: string }> {
    if (this.pendingDialogResolve) {
      this.pendingDialogResolve(button);
      this.pendingDialogResolve = undefined;
      return { clicked: button };
    }
    throw new Error('No dialog is currently pending');
  }

  createDialogPromise(): Promise<string> {
    return new Promise((resolve) => {
      this.pendingDialogResolve = resolve;
    });
  }

  private async interceptShowQuickPick<T extends vscode.QuickPickItem>(
    original: typeof vscode.window.showQuickPick,
    items: readonly T[] | Thenable<readonly T[]>,
    options: vscode.QuickPickOptions = {},
    token?: vscode.CancellationToken,
  ): Promise<T | T[] | undefined> {
    const session = this.createSession('quickPick', 'showQuickPick');
    session.quickPickOptions = options;
    session.title = options.title;
    session.placeholder = options.placeHolder;
    session.canSelectMany = options.canPickMany;
    this.setActiveSession(session);

    try {
      const resolvedItems = await Promise.resolve(items);
      this.setQuickPickItems(session, [...resolvedItems]);
      const originalPromise = original.call(vscode.window, resolvedItems as any, options, token) as Thenable<T | T[] | undefined>;
      return await this.wrapQuickPickPromise(session, originalPromise);
    } catch (err) {
      this.disposeSession(session);
      if (this.activeSession?.id === session.id) this.activeSession = undefined;
      throw err;
    }
  }

  private interceptCreateQuickPick<T extends vscode.QuickPickItem>(
    original: typeof vscode.window.createQuickPick,
  ): vscode.QuickPick<T> {
    const handle = original.call(vscode.window) as vscode.QuickPick<T>;
    const session = this.createSession('quickPick', 'createQuickPick');
    session.handle = handle as unknown as vscode.QuickPick<vscode.QuickPickItem>;
    this.syncQuickPickFromHandle(session, handle as unknown as vscode.QuickPick<vscode.QuickPickItem>);

    session.disposables.push(
      handle.onDidChangeValue((value) => {
        session.value = value;
        session.updatedAt = Date.now();
      }),
      handle.onDidChangeActive((items) => {
        session.activeItems = this.mapRawItems(session, items);
        session.updatedAt = Date.now();
      }),
      handle.onDidChangeSelection((items) => {
        session.selectedItems = this.mapRawItems(session, items);
        session.updatedAt = Date.now();
      }),
      handle.onDidHide(() => {
        if (this.activeSession?.id === session.id) this.activeSession = undefined;
      }),
    );

    return new Proxy(handle, {
      get: (target, property, receiver) => {
        if (property === 'show') {
          return () => {
            this.syncQuickPickFromHandle(session, target as unknown as vscode.QuickPick<vscode.QuickPickItem>);
            this.setActiveSession(session);
            return target.show();
          };
        }
        if (property === 'hide') {
          return () => {
            if (this.activeSession?.id === session.id) this.activeSession = undefined;
            return target.hide();
          };
        }
        if (property === 'dispose') {
          return () => {
            this.disposeSession(session);
            return target.dispose();
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set: (target, property, value, receiver) => {
        const didSet = Reflect.set(target, property, value, receiver);
        this.syncQuickPickFromHandle(session, target as unknown as vscode.QuickPick<vscode.QuickPickItem>);
        return didSet;
      },
    });
  }

  private interceptShowInputBox(
    original: typeof vscode.window.showInputBox,
    options: vscode.InputBoxOptions = {},
    token?: vscode.CancellationToken,
  ): Promise<string | undefined> {
    const session = this.createSession('inputBox', 'showInputBox');
    session.inputOptions = options;
    session.title = options.title;
    session.prompt = options.prompt;
    session.placeholder = options.placeHolder;
    session.value = options.value;
    this.setActiveSession(session);

    try {
      const originalPromise = original.call(vscode.window, options, token) as Thenable<string | undefined>;
      return this.wrapInputBoxPromise(session, originalPromise);
    } catch (err) {
      this.disposeSession(session);
      if (this.activeSession?.id === session.id) this.activeSession = undefined;
      throw err;
    }
  }

  private interceptCreateInputBox(original: typeof vscode.window.createInputBox): vscode.InputBox {
    const handle = original.call(vscode.window);
    const session = this.createSession('inputBox', 'createInputBox');
    session.handle = handle;
    this.syncInputBoxFromHandle(session, handle);

    session.disposables.push(
      handle.onDidChangeValue((value) => {
        session.value = value;
        this.syncInputBoxFromHandle(session, handle);
      }),
      handle.onDidHide(() => {
        if (this.activeSession?.id === session.id) this.activeSession = undefined;
      }),
    );

    return new Proxy(handle, {
      get: (target, property, receiver) => {
        if (property === 'show') {
          return () => {
            this.syncInputBoxFromHandle(session, target);
            this.setActiveSession(session);
            return target.show();
          };
        }
        if (property === 'hide') {
          return () => {
            if (this.activeSession?.id === session.id) this.activeSession = undefined;
            return target.hide();
          };
        }
        if (property === 'dispose') {
          return () => {
            this.disposeSession(session);
            return target.dispose();
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set: (target, property, value, receiver) => {
        const didSet = Reflect.set(target, property, value, receiver);
        this.syncInputBoxFromHandle(session, target);
        return didSet;
      },
    });
  }

  private createSession(kind: QuickInputSession['kind'], source: QuickInputSession['source']): QuickInputSession {
    const now = Date.now();
    return {
      id: `quickinput-${++this.sessionCounter}`,
      kind,
      source,
      createdAt: now,
      updatedAt: now,
      items: [],
      activeItems: [],
      selectedItems: [],
      disposables: [],
    };
  }

  private setActiveSession(session: QuickInputSession): void {
    this.activeSession = session;
    session.updatedAt = Date.now();
  }

  private wrapQuickPickPromise<T>(session: QuickInputSession, originalPromise: Thenable<T | T[] | undefined>): Promise<T | T[] | undefined> {
    return new Promise((resolve, reject) => {
      session.resolve = resolve as (value: unknown) => void;
      session.reject = reject;
      Promise.resolve(originalPromise).then(
        (result) => {
          if (session.completed) return;
          session.completed = true;
          this.captureQuickPickResult(session, result);
          this.disposeSession(session);
          if (this.activeSession?.id === session.id) this.activeSession = undefined;
          resolve(result);
        },
        (err) => {
          if (session.completed) return;
          session.completed = true;
          this.disposeSession(session);
          if (this.activeSession?.id === session.id) this.activeSession = undefined;
          reject(err);
        },
      );
    });
  }

  private wrapInputBoxPromise(session: QuickInputSession, originalPromise: Thenable<string | undefined>): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      session.resolve = resolve as (value: unknown) => void;
      session.reject = reject;
      Promise.resolve(originalPromise).then(
        (result) => {
          if (session.completed) return;
          session.completed = true;
          session.value = result;
          this.disposeSession(session);
          if (this.activeSession?.id === session.id) this.activeSession = undefined;
          resolve(result);
        },
        (err) => {
          if (session.completed) return;
          session.completed = true;
          this.disposeSession(session);
          if (this.activeSession?.id === session.id) this.activeSession = undefined;
          reject(err);
        },
      );
    });
  }

  private setQuickPickItems(session: QuickInputSession, rawItems: readonly unknown[]): void {
    session.items = rawItems.map((raw, index) => this.serializeQuickPickItem(session, raw, index));
    session.activeItems = this.mapRawItems(session, session.activeItems.map((item) => item.raw));
    session.selectedItems = this.mapRawItems(session, session.selectedItems.map((item) => item.raw));
    session.updatedAt = Date.now();
  }

  private serializeQuickPickItem(session: QuickInputSession, raw: unknown, index: number): TrackedQuickInputItem {
    const label = getQuickPickLabel(raw);
    const objectItem = isQuickPickObject(raw) ? raw : undefined;
    const kind = objectItem?.kind === vscode.QuickPickItemKind.Separator ? 'separator' : 'item';
    return {
      id: `${session.id}-item-${index}`,
      raw,
      info: {
        id: `${session.id}-item-${index}`,
        label,
        matchLabel: stripThemeIcons(label),
        description: objectItem?.description,
        detail: objectItem?.detail,
        kind,
        picked: objectItem?.picked,
        alwaysShow: objectItem?.alwaysShow,
        buttons: objectItem?.buttons?.map((button) => button.tooltip ?? 'button'),
      },
    };
  }

  private findSelectableItem(session: QuickInputSession, target: string): TrackedQuickInputItem {
    const byId = session.items.find((item) => item.id === target);
    if (byId) return assertSelectableItem(byId);

    const normalized = normalizeLabel(target);
    const exact = session.items.filter((item) => normalizeLabel(item.info.label) === normalized || normalizeLabel(item.info.matchLabel) === normalized);
    const matches = exact.length > 0
      ? exact
      : session.items.filter((item) => normalizeLabel(item.info.label).includes(normalized) || normalizeLabel(item.info.matchLabel).includes(normalized));

    if (matches.length === 0) {
      throw new Error(`QuickInput item "${target}" not found. Available items: ${session.items.map((item) => `${item.info.label} (${item.id})`).join(', ')}`);
    }
    if (matches.length > 1) {
      throw new Error(`QuickInput item "${target}" matched multiple items. Use an item id: ${matches.map((item) => `${item.info.label} (${item.id})`).join(', ')}`);
    }
    return assertSelectableItem(matches[0]);
  }

  private selectedLabels(session: QuickInputSession): string | string[] {
    const labels = session.selectedItems.map((item) => item.info.label);
    return session.canSelectMany ? labels : labels[0] ?? '';
  }

  private syncQuickPickFromHandle(session: QuickInputSession, handle: vscode.QuickPick<vscode.QuickPickItem>): void {
    session.handle = handle;
    session.title = handle.title;
    session.placeholder = handle.placeholder;
    session.value = handle.value;
    session.busy = handle.busy;
    session.enabled = handle.enabled;
    session.canSelectMany = handle.canSelectMany;
    this.setQuickPickItems(session, [...handle.items]);
    session.activeItems = this.mapRawItems(session, [...handle.activeItems]);
    session.selectedItems = this.mapRawItems(session, [...handle.selectedItems]);
    session.updatedAt = Date.now();
  }

  private syncInputBoxFromHandle(session: QuickInputSession, handle: vscode.InputBox): void {
    session.handle = handle;
    session.title = handle.title;
    session.placeholder = handle.placeholder;
    session.prompt = handle.prompt;
    session.value = handle.value;
    session.busy = handle.busy;
    session.enabled = handle.enabled;
    session.validationMessage = validationMessageToString(handle.validationMessage);
    session.updatedAt = Date.now();
  }

  private mapRawItems(session: QuickInputSession, rawItems: readonly unknown[]): TrackedQuickInputItem[] {
    return rawItems
      .map((raw) => session.items.find((item) => item.raw === raw))
      .filter((item): item is TrackedQuickInputItem => Boolean(item));
  }

  private captureQuickPickResult(session: QuickInputSession, result: unknown): void {
    const rawItems = Array.isArray(result) ? result : result === undefined ? [] : [result];
    session.selectedItems = this.mapRawItems(session, rawItems);
    session.updatedAt = Date.now();
  }

  private async validateShowInputBox(session: QuickInputSession, value: string): Promise<string | undefined> {
    const validateInput = session.inputOptions?.validateInput;
    if (!validateInput) return undefined;
    const result = await Promise.resolve(validateInput(value));
    return validationBlockingMessage(result);
  }

  private async waitForInputBoxValidation(session: QuickInputSession, handle: vscode.InputBox): Promise<string | undefined> {
    let lastMessage = validationMessageToString(handle.validationMessage);
    let stableSamples = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(50);
      this.syncInputBoxFromHandle(session, handle);
      const currentMessage = validationMessageToString(handle.validationMessage);
      if (currentMessage === lastMessage) {
        stableSamples++;
        if (stableSamples >= 3) return validationBlockingMessage(handle.validationMessage);
      } else {
        stableSamples = 0;
      }
      lastMessage = currentMessage;
    }
    return validationBlockingMessage(handle.validationMessage);
  }

  private invokeShowQuickPickSelectItem(session: QuickInputSession, raw: unknown): void {
    try {
      session.quickPickOptions?.onDidSelectItem?.(raw as any);
    } catch { /* match VS Code's best-effort UI event behavior for tests */ }
  }

  private snapshot(session: QuickInputSession): QuickInputState {
    return {
      active: true,
      id: session.id,
      kind: session.kind,
      source: session.source,
      title: session.title,
      placeholder: session.placeholder,
      prompt: session.prompt,
      value: session.value,
      validationMessage: session.validationMessage,
      busy: session.busy,
      enabled: session.enabled,
      canSelectMany: session.canSelectMany,
      items: session.items.map((item) => ({ ...item.info })),
      activeItems: session.activeItems.map((item) => ({ ...item.info })),
      selectedItems: session.selectedItems.map((item) => ({ ...item.info })),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private disposeSession(session: QuickInputSession): void {
    for (const disposable of session.disposables) {
      try { disposable.dispose(); } catch { /* best effort */ }
    }
    session.disposables = [];
  }
}

function isQuickPickObject(value: unknown): value is vscode.QuickPickItem {
  return typeof value === 'object' && value !== null && 'label' in value;
}

function isQuickPickHandle(handle: vscode.QuickPick<vscode.QuickPickItem> | vscode.InputBox): handle is vscode.QuickPick<vscode.QuickPickItem> {
  return 'items' in handle && 'selectedItems' in handle;
}

function isInputBoxHandle(handle: vscode.QuickPick<vscode.QuickPickItem> | vscode.InputBox): handle is vscode.InputBox {
  return 'prompt' in handle && !('items' in handle);
}

function getQuickPickLabel(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (isQuickPickObject(raw)) return raw.label;
  return String(raw);
}

function stripThemeIcons(label: string): string {
  return label.replace(/\$\([^)]+\)\s*/g, '').trim();
}

function normalizeLabel(label: string): string {
  return stripThemeIcons(label).toLowerCase();
}

function assertSelectableItem(item: TrackedQuickInputItem): TrackedQuickInputItem {
  if (item.info.kind === 'separator') {
    throw new Error(`QuickInput item "${item.info.label}" is a separator and cannot be selected`);
  }
  return item;
}

function validationMessageToString(value: string | vscode.InputBoxValidationMessage | null | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return value.message;
}

function validationBlockingMessage(value: string | vscode.InputBoxValidationMessage | null | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return value.severity === vscode.InputBoxValidationSeverity.Error ? value.message : undefined;
}

function isLegacyQuickPickFallbackError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('No QuickPick is currently active') ||
    err.message.includes('not found') ||
    err.message.includes('matched multiple');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
