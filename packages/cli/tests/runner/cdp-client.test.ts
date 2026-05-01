import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCdpFactoryRef, mockClientRef } = vi.hoisted(() => ({
  mockCdpFactoryRef: { current: vi.fn() },
  mockClientRef: { current: null as any },
}));

vi.mock('chrome-remote-interface', () => ({
  default: mockCdpFactoryRef.current,
}));

const { CdpClient } = await import('../../src/runner/cdp-client.js');

function createMockClient() {
  return {
    Runtime: {
      disable: vi.fn().mockResolvedValue(undefined),
      enable: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn(),
    },
    Input: {
      dispatchMouseEvent: vi.fn().mockResolvedValue(undefined),
      dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      insertText: vi.fn().mockResolvedValue(undefined),
    },
    close: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

function setupSingleWebviewContext(contextId = 1): void {
  let contextHandler: ((params: { context: { id: number } }) => void) | undefined;
  mockClientRef.current.on.mockImplementation((event: string, handler: typeof contextHandler) => {
    if (event === 'Runtime.executionContextCreated') contextHandler = handler;
  });
  mockClientRef.current.Runtime.enable.mockImplementation(() => {
    contextHandler?.({ context: { id: contextId } });
    return Promise.resolve(undefined);
  });
  (mockCdpFactoryRef.current as any).List = vi.fn().mockResolvedValue([
    { type: 'page', url: 'vscode-webview://kusto', id: 'target-1', title: 'Kusto Workbench' },
  ]);
}

describe('CdpClient', () => {
  let client: InstanceType<typeof CdpClient>;

  beforeEach(() => {
    mockClientRef.current = createMockClient();
    mockCdpFactoryRef.current.mockReset();
    (mockCdpFactoryRef.current as any).List = vi.fn().mockResolvedValue([]);
    mockCdpFactoryRef.current.mockResolvedValue(mockClientRef.current);
    client = new CdpClient(9333);
  });

  afterEach(() => {
    client.disconnect();
  });

  it('connects on the configured port and enables Runtime', async () => {
    await client.connect();

    expect(mockCdpFactoryRef.current).toHaveBeenCalledWith({ port: 9333 });
    expect(mockClientRef.current.Runtime.enable).toHaveBeenCalled();
  });

  it('moves the mouse with CDP pointer coordinates', async () => {
    await client.connect();

    await client.moveMouse(10, 20);

    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenCalledWith({
      type: 'mouseMoved',
      x: 10,
      y: 20,
      button: 'none',
    });
  });

  it('clicks with button and click count payloads', async () => {
    await client.connect();

    await client.clickAt(30, 40, { button: 'right', clickCount: 2 });

    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenNthCalledWith(1, {
      type: 'mouseMoved',
      x: 30,
      y: 40,
      button: 'none',
    });
    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenNthCalledWith(2, {
      type: 'mousePressed',
      x: 30,
      y: 40,
      button: 'right',
      buttons: 2,
      clickCount: 1,
    });
    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenNthCalledWith(3, {
      type: 'mouseReleased',
      x: 30,
      y: 40,
      button: 'right',
      buttons: 0,
      clickCount: 1,
    });
    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenNthCalledWith(4, {
      type: 'mousePressed',
      x: 30,
      y: 40,
      button: 'right',
      buttons: 2,
      clickCount: 2,
    });
    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenNthCalledWith(5, {
      type: 'mouseReleased',
      x: 30,
      y: 40,
      button: 'right',
      buttons: 0,
      clickCount: 2,
    });
  });

  it('uses real pointer events for main-document selector clicks', async () => {
    mockClientRef.current.Runtime.evaluate.mockResolvedValue({
      result: { value: { x: 50, y: 60 } },
    });
    await client.connect();

    await client.clickSelector('#run');

    expect(mockClientRef.current.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining("document.querySelector('#run')"),
      returnByValue: true,
    }));
    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mousePressed',
      x: 50,
      y: 60,
      button: 'left',
      buttons: 1,
    }));
  });

  it('selects popup menu items with real pointer events', async () => {
    mockClientRef.current.Runtime.evaluate
      .mockResolvedValueOnce({ result: { value: { text: 'StormEvents', x: 120, y: 240 } } })
      .mockResolvedValue({ result: { value: { editors: 0, repaired: false } } });
    await client.connect();

    await client.selectPopupMenuItem('Storm');

    const selectionExpression = mockClientRef.current.Runtime.evaluate.mock.calls[0][0].expression;
    expect(selectionExpression).toContain('.suggest-widget.visible .monaco-list-row');
    expect(selectionExpression).toContain('shadowRoot');
    expect(selectionExpression).not.toContain('.click()');
    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenNthCalledWith(1, {
      type: 'mouseMoved',
      x: 120,
      y: 240,
      button: 'none',
    });
    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'mousePressed',
      x: 120,
      y: 240,
      button: 'left',
      buttons: 1,
    }));
  });

  it('rejects blank popup menu item text before clicking', async () => {
    await client.connect();

    await expect(client.selectPopupMenuItem('   ')).rejects.toThrow('Popup menu item text cannot be empty');

    expect(mockClientRef.current.Runtime.evaluate).not.toHaveBeenCalled();
    expect(mockClientRef.current.Input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  it('falls back to webview frame contexts for popup menu items', async () => {
    setupSingleWebviewContext(11);
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression, contextId }: { expression: string; contextId?: number }) => {
      if (expression.includes('data-vscode-ext-test-monaco-focus-repair')) {
        return Promise.resolve({ result: { value: { editors: 1, repaired: true } } });
      }
      if (expression.includes('.suggest-widget.visible .monaco-list-row') && contextId === 11) {
        return Promise.resolve({ result: { value: { text: 'StormEvents', x: 77, y: 88 } } });
      }
      if (expression.includes('.suggest-widget.visible .monaco-list-row')) {
        return Promise.resolve({ result: { value: { error: 'not in main renderer' } } });
      }
      return Promise.resolve({ result: { value: undefined } });
    });
    await client.connect();

    await client.selectPopupMenuItem('Storm');

    expect(mockClientRef.current.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining('.suggest-widget.visible .monaco-list-row'),
      contextId: 11,
    }));
    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenNthCalledWith(1, {
      type: 'mouseMoved',
      x: 77,
      y: 88,
      button: 'none',
    });
  });

  it('lists popup menu items from webview frame contexts', async () => {
    setupSingleWebviewContext(13);
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression, contextId }: { expression: string; contextId?: number }) => {
      if (expression.includes('return Array.from(new Set(items))') && contextId === 13) {
        return Promise.resolve({ result: { value: ['StormEvents', 'StormEvents'] } });
      }
      if (expression.includes('return Array.from(new Set(items))')) {
        return Promise.resolve({ result: { value: [] } });
      }
      return Promise.resolve({ result: { value: undefined } });
    });
    await client.connect();

    const items = await client.getPopupMenuItems();

    expect(items).toEqual(['StormEvents']);
    expect(mockClientRef.current.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining('return Array.from(new Set(items))'),
      contextId: 13,
    }));
    expect(mockClientRef.current.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining('shadowRoot'),
      contextId: 13,
    }));
  });

  it('stabilizes Monaco popup focus inside webview frame contexts', async () => {
    setupSingleWebviewContext(7);
    mockClientRef.current.Runtime.evaluate.mockResolvedValue({ result: { value: { editors: 1, repaired: true } } });
    await client.connect();

    await client.stabilizeMonacoAfterPopupSelection();

    expect(mockClientRef.current.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining('data-vscode-ext-test-monaco-focus-repair'),
    }));
    expect(mockClientRef.current.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining('shadowRoot'),
    }));
    expect(mockClientRef.current.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining('data-vscode-ext-test-monaco-focus-repair'),
      contextId: 7,
    }));
  });

  it('maps punctuation keyboard chords to valid CDP codes', async () => {
    await client.connect();

    await client.pressKey('Ctrl+/');
    await client.pressKey('Ctrl+[');
    await client.pressKey('Ctrl+]');
    await client.pressKey('Ctrl+=');
    await client.pressKey('Ctrl+-');
    await client.pressKey('Ctrl+`');

    expect(mockClientRef.current.Input.dispatchKeyEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 2,
    }));
    expect(mockClientRef.current.Input.dispatchKeyEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({
      type: 'keyDown', key: '[', code: 'BracketLeft', windowsVirtualKeyCode: 219, modifiers: 2,
    }));
    expect(mockClientRef.current.Input.dispatchKeyEvent).toHaveBeenNthCalledWith(5, expect.objectContaining({
      type: 'keyDown', key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221, modifiers: 2,
    }));
    expect(mockClientRef.current.Input.dispatchKeyEvent).toHaveBeenNthCalledWith(7, expect.objectContaining({
      type: 'keyDown', key: '=', code: 'Equal', windowsVirtualKeyCode: 187, modifiers: 2,
    }));
    expect(mockClientRef.current.Input.dispatchKeyEvent).toHaveBeenNthCalledWith(9, expect.objectContaining({
      type: 'keyDown', key: '-', code: 'Minus', windowsVirtualKeyCode: 189, modifiers: 2,
    }));
    expect(mockClientRef.current.Input.dispatchKeyEvent).toHaveBeenNthCalledWith(11, expect.objectContaining({
      type: 'keyDown', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, modifiers: 2,
    }));
  });

  it('throws for unsupported key specs before dispatching events', async () => {
    await client.connect();

    await expect(client.pressKey('Ctrl+DefinitelyNotAKey')).rejects.toThrow('Unsupported key spec');
    expect(mockClientRef.current.Input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  it('reads visible workbench QuickInput state from the renderer DOM', async () => {
    mockClientRef.current.Runtime.evaluate.mockResolvedValue({
      result: {
        value: {
          active: true,
          source: 'workbench',
          title: 'Select subscription',
          items: [{ id: 'workbench-item-0', label: 'Contoso', matchLabel: 'Contoso' }],
        },
      },
    });
    await client.connect();

    const state = await client.getWorkbenchQuickInputState();

    expect(state).toMatchObject({ active: true, source: 'workbench', title: 'Select subscription' });
    expect(mockClientRef.current.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining('.quick-input-widget'),
      returnByValue: true,
    }));
  });

  it('selects a workbench QuickInput item with real pointer events', async () => {
    mockClientRef.current.Runtime.evaluate.mockResolvedValue({
      result: { value: { label: 'Contoso', x: 100, y: 200 } },
    });
    await client.connect();

    const result = await client.selectWorkbenchQuickInputItem('Contoso');

    expect(result).toEqual({ selected: 'Contoso', intercepted: false });
    expect(mockClientRef.current.Input.dispatchMouseEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mousePressed',
      x: 100,
      y: 200,
    }));
  });

  it('focuses and accepts workbench QuickInput text', async () => {
    mockClientRef.current.Runtime.evaluate.mockResolvedValue({ result: { value: { focused: true } } });
    await client.connect();

    const result = await client.submitWorkbenchQuickInputText('new-project');

    expect(result).toEqual({ entered: 'new-project', intercepted: false, accepted: true });
    expect(mockClientRef.current.Input.insertText).toHaveBeenCalledWith({ text: 'new-project' });
    expect(mockClientRef.current.Input.dispatchKeyEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'keyDown',
      key: 'Enter',
    }));
  });

  it('rejects when Runtime.evaluate never settles', async () => {
    vi.useFakeTimers();
    mockClientRef.current.Runtime.evaluate.mockReturnValue(new Promise(() => {}));

    try {
      await client.connect();
      const evaluation = client.evaluate('window.__never');
      const assertion = expect(evaluation).rejects.toThrow('CDP Runtime.evaluate timed out after 5000ms');

      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses an explicit evaluate timeout for user diagnostics', async () => {
    vi.useFakeTimers();
    mockClientRef.current.Runtime.evaluate.mockReturnValue(new Promise(() => {}));

    try {
      await client.connect();
      const evaluation = client.evaluate('window.__longDiagnostic', { timeoutMs: 25_000 });
      let settled = false;
      evaluation.catch(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);

      const assertion = expect(evaluation).rejects.toThrow('CDP Runtime.evaluate timed out after 25000ms');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let the 5s webview operation wrapper preempt explicit long webview evals', async () => {
    vi.useFakeTimers();
    let contextHandler: ((params: { context: { id: number } }) => void) | undefined;
    mockClientRef.current.on.mockImplementation((event: string, handler: typeof contextHandler) => {
      if (event === 'Runtime.executionContextCreated') contextHandler = handler;
    });
    mockClientRef.current.Runtime.enable.mockImplementation(() => {
      contextHandler?.({ context: { id: 1 } });
      return Promise.resolve(undefined);
    });
    mockClientRef.current.Runtime.evaluate.mockReturnValue(new Promise(() => {}));
    (mockCdpFactoryRef.current as any).List = vi.fn().mockResolvedValue([
      { type: 'page', url: 'vscode-webview://kusto', id: 'target-1', title: 'Kusto Workbench' },
    ]);

    try {
      const evaluation = client.evaluateInWebview('waitForCompletionTargets(25000)', undefined, { timeoutMs: 25_000 });
      let settled = false;
      evaluation.catch(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);

      const assertion = expect(evaluation).rejects.toThrow('25000ms');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses DOM events before mouse dispatch for explicit webview selector clicks', async () => {
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockResolvedValue({ result: { value: true } });

    await client.clickInWebviewBySelector("button[data-add-kind='query']");

    const firstEvaluation = mockClientRef.current.Runtime.evaluate.mock.calls[0][0].expression;
    expect(firstEvaluation).toContain("button[data-add-kind=\\'query\\']");
    expect(firstEvaluation).toContain('PointerEvent');
    expect(mockClientRef.current.Input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  it('clicks a webview element by accessible text using a marked candidate', async () => {
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression }: { expression: string }) => {
      if (expression.includes('actionableSelector')) {
        return Promise.resolve({
          result: {
            value: {
              exact: [{ marker: 'marker-1', name: 'Try In Playground', tag: 'button' }],
              fuzzy: [],
              candidates: [{ marker: 'marker-1', name: 'Try In Playground', tag: 'button' }],
            },
          },
        });
      }
      if (expression.includes('marker-1')) return Promise.resolve({ result: { value: true } });
      return Promise.resolve({ result: { value: undefined } });
    });

    await client.clickInWebviewByAccessibleText('Try In Playground');

    const candidateExpression = mockClientRef.current.Runtime.evaluate.mock.calls[0][0].expression;
    const clickExpression = mockClientRef.current.Runtime.evaluate.mock.calls[1][0].expression;
    expect(candidateExpression).toContain('aria-label');
    expect(candidateExpression).toContain('title');
    expect(clickExpression).toContain('data-vscode-ext-test-text-click');
    expect(clickExpression).toContain('PointerEvent');
  });

  it('throws a diagnostic error when webview text matches multiple elements', async () => {
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockResolvedValue({
      result: {
        value: {
          exact: [
            { marker: 'marker-1', name: 'Run', tag: 'button' },
            { marker: 'marker-2', name: 'Run', tag: 'button' },
          ],
          fuzzy: [],
          candidates: [],
        },
      },
    });

    await expect(client.clickInWebviewByAccessibleText('Run')).rejects.toMatchObject({
      message: expect.stringContaining('matched multiple actionable elements'),
      diagnostic: expect.objectContaining({
        kind: 'webview-click',
        subject: 'Run',
        candidates: expect.arrayContaining([expect.objectContaining({ marker: 'marker-1' })]),
      }),
    });
  });

  it('throws a diagnostic error with candidate names when webview text is not found', async () => {
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockResolvedValue({
      result: {
        value: {
          exact: [],
          fuzzy: [],
          candidates: [{ name: 'Try In Playground', tag: 'button' }],
        },
      },
    });

    await expect(client.clickInWebviewByAccessibleText('Missing')).rejects.toMatchObject({
      message: expect.stringContaining('Webview element with text "Missing" not found'),
      diagnostic: expect.objectContaining({
        kind: 'webview-click',
        subject: 'Missing',
        candidates: expect.arrayContaining([expect.objectContaining({ name: 'Try In Playground' })]),
      }),
    });
  });

  it('collects structured webview body text evidence with bounded samples and match context', async () => {
    setupSingleWebviewContext();
    const bodyText = `Intro ${'x'.repeat(1200)} Needle value`;
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression }: { expression: string }) => {
      if (expression.includes('document.title')) return Promise.resolve({ result: { value: 'Dashboard' } });
      if (expression.includes('document.body')) return Promise.resolve({ result: { value: bodyText } });
      return Promise.resolve({ result: { value: undefined } });
    });

    const result = await client.getWebviewBodyTextEvidence(undefined, 'Needle');

    expect(result.text).toBe(bodyText);
    expect(result.evidence).toMatchObject({
      kind: 'webview-body',
      expectedText: 'Needle',
      matched: true,
      targetCount: 1,
    });
    expect(result.evidence.targets[0]).toMatchObject({
      title: 'Kusto Workbench',
      probedTitle: 'Dashboard',
      matched: true,
    });
    expect(result.evidence.targets[0].textSample!.length).toBeLessThanOrEqual(1000);
    expect(result.evidence.targets[0].truncated).toBe(true);
    expect(result.evidence.targets[0].matchContext).toContain('Needle value');
  });

  it('keeps getWebviewBodyText as a compatibility wrapper', async () => {
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression }: { expression: string }) => {
      if (expression.includes('document.title')) return Promise.resolve({ result: { value: 'Dashboard' } });
      if (expression.includes('document.body')) return Promise.resolve({ result: { value: 'Body text' } });
      return Promise.resolve({ result: { value: undefined } });
    });

    await expect(client.getWebviewBodyText()).resolves.toBe('Body text');
  });

  it('collects structured webview element text evidence', async () => {
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression }: { expression: string }) => {
      if (expression.includes('document.title')) return Promise.resolve({ result: { value: 'Settings' } });
      if (expression.includes('.status')) return Promise.resolve({ result: { value: 'Ready to run' } });
      return Promise.resolve({ result: { value: undefined } });
    });

    const result = await client.getElementTextEvidence('.status', undefined, 'Ready');

    expect(result.text).toBe('Ready to run');
    expect(result.evidence).toMatchObject({
      kind: 'webview-element',
      selector: '.status',
      expectedText: 'Ready',
      matched: true,
      targetCount: 1,
    });
    expect(result.evidence.targets[0]).toMatchObject({
      probedTitle: 'Settings',
      textSample: 'Ready to run',
    });
  });

  it('returns selector evidence when an element is missing', async () => {
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression }: { expression: string }) => {
      if (expression.includes('document.title')) return Promise.resolve({ result: { value: 'Settings' } });
      if (expression.includes('.missing')) return Promise.resolve({ result: { value: null } });
      return Promise.resolve({ result: { value: undefined } });
    });

    const result = await client.getElementTextEvidence('.missing', undefined, 'Ready');

    expect(result.text).toBeUndefined();
    expect(result.evidence).toMatchObject({
      kind: 'webview-element',
      selector: '.missing',
      expectedText: 'Ready',
      matched: false,
      targetCount: 1,
    });
    expect(result.evidence.targets[0]).toMatchObject({ title: 'Kusto Workbench', probedTitle: 'Settings' });
  });

  it('returns title mismatch evidence for titled selector assertions', async () => {
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression }: { expression: string }) => {
      if (expression.includes('document.title')) return Promise.resolve({ result: { value: 'Dashboard' } });
      return Promise.resolve({ result: { value: undefined } });
    });

    const result = await client.getElementTextEvidence('.status', 'Definitely Wrong Title', 'Ready');

    expect(result.text).toBeUndefined();
    expect(result.error).toContain('No webview found matching title "Definitely Wrong Title"');
    expect(result.evidence).toMatchObject({
      kind: 'webview-element',
      titleFilter: 'Definitely Wrong Title',
      selector: '.status',
      expectedText: 'Ready',
      matched: false,
      targetCount: 1,
    });
    expect(result.evidence.targets[0]).toMatchObject({ title: 'Kusto Workbench', probedTitle: 'Dashboard' });
  });

  it('lists webviews with structured visible text samples', async () => {
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression }: { expression: string }) => {
      if (expression.includes('document.title')) return Promise.resolve({ result: { value: 'Dashboard' } });
      if (expression.includes('document.body')) return Promise.resolve({ result: { value: 'Visible dashboard text' } });
      return Promise.resolve({ result: { value: undefined } });
    });

    const evidence = await client.listWebviewTextEvidence();

    expect(evidence).toMatchObject({ kind: 'webview-list', targetCount: 1 });
    expect(evidence.targets[0]).toMatchObject({
      title: 'Kusto Workbench',
      probedTitle: 'Dashboard',
      textSample: 'Visible dashboard text',
    });
  });

  it('bounds title probing while listing webview text evidence', async () => {
    vi.useFakeTimers();
    setupSingleWebviewContext();
    mockClientRef.current.Runtime.evaluate.mockImplementation(({ expression }: { expression: string }) => {
      if (expression.includes('document.title')) return new Promise(() => undefined);
      if (expression.includes('document.body')) return Promise.resolve({ result: { value: 'Visible fallback text' } });
      return Promise.resolve({ result: { value: undefined } });
    });

    try {
      const evidencePromise = client.listWebviewTextEvidence();
      await vi.advanceTimersByTimeAsync(3_000);
      const evidence = await evidencePromise;

      expect(evidence).toMatchObject({ kind: 'webview-list', targetCount: 1 });
      expect(evidence.targets[0]).toMatchObject({
        title: 'Kusto Workbench',
        textSample: 'Visible fallback text',
      });
      expect(evidence.targets[0].probedTitle).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
