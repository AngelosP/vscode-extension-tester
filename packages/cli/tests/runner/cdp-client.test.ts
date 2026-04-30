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

  it('uses DOM events before mouse dispatch for explicit webview selector clicks', async () => {
    let contextHandler: ((params: { context: { id: number } }) => void) | undefined;
    mockClientRef.current.on.mockImplementation((event: string, handler: typeof contextHandler) => {
      if (event === 'Runtime.executionContextCreated') contextHandler = handler;
    });
    mockClientRef.current.Runtime.enable.mockImplementation(() => {
      contextHandler?.({ context: { id: 1 } });
      return Promise.resolve(undefined);
    });
    mockClientRef.current.Runtime.evaluate.mockResolvedValue({ result: { value: true } });
    (mockCdpFactoryRef.current as any).List = vi.fn().mockResolvedValue([
      { type: 'page', url: 'vscode-webview://kusto', id: 'target-1', title: 'Kusto Workbench' },
    ]);

    await client.clickInWebviewBySelector("button[data-add-kind='query']");

    const firstEvaluation = mockClientRef.current.Runtime.evaluate.mock.calls[0][0].expression;
    expect(firstEvaluation).toContain("button[data-add-kind=\\'query\\']");
    expect(firstEvaluation).toContain('PointerEvent');
    expect(mockClientRef.current.Input.dispatchMouseEvent).not.toHaveBeenCalled();
  });
});
