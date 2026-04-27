import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

// ─── child_process mock ──────────────────────────────────────────────────────
// We need a controllable fake process whose stdin captures writes and whose
// stdout emits JSON response lines on demand. The stdout must be a real
// Readable (PassThrough) because readline.createInterface() requires it.

/** Lines written to the fake process stdin (accumulated across calls). */
let stdinWrites: string[] = [];

/** The PassThrough stream used as fake stdout — push lines here to simulate bridge responses. */
let fakeStdout: PassThrough;

/** Whether the fake process has been killed. */
let processKilled: boolean;

function createFakeProcess() {
  fakeStdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.create(require('node:events').EventEmitter.prototype) as any;
  require('node:events').EventEmitter.call(proc);

  processKilled = false;

  const stdin = {
    write: vi.fn((data: string) => { stdinWrites.push(data); }),
  };

  proc.stdin = stdin;
  proc.stdout = fakeStdout;
  proc.stderr = stderr;
  proc.kill = vi.fn(() => { processKilled = true; });

  Object.defineProperty(proc, 'killed', {
    get: () => processKilled,
    configurable: true,
  });

  return proc;
}

let fakeProcess: ReturnType<typeof createFakeProcess>;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => fakeProcess),
  execSync: vi.fn(() => ''),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

// Dynamic import after mock setup
const { NativeUIClient } = await import('../../src/runner/native-ui-client.js');
import * as cp from 'node:child_process';
import * as fs from 'node:fs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Set up the mock so the next call() resolves with `result`. */
function respondWith(result: unknown): void {
  // Hook stdin.write so that when the client sends a command, we immediately
  // push a response line onto the fake stdout PassThrough stream.
  const writeFn = fakeProcess.stdin!.write as ReturnType<typeof vi.fn>;
  writeFn.mockImplementationOnce((data: string) => {
    stdinWrites.push(data);
    // Push on next microtick so readline has time to process
    queueMicrotask(() => {
      fakeStdout.push(JSON.stringify({ result }) + '\n');
    });
    return true;
  });
}

function respondWithError(error: string): void {
  const writeFn = fakeProcess.stdin!.write as ReturnType<typeof vi.fn>;
  writeFn.mockImplementationOnce((data: string) => {
    stdinWrites.push(data);
    queueMicrotask(() => {
      fakeStdout.push(JSON.stringify({ error }) + '\n');
    });
    return true;
  });
}

function respondWithRaw(raw: string): void {
  const writeFn = fakeProcess.stdin!.write as ReturnType<typeof vi.fn>;
  writeFn.mockImplementationOnce((data: string) => {
    stdinWrites.push(data);
    queueMicrotask(() => {
      fakeStdout.push(raw + '\n');
    });
    return true;
  });
}

const SAMPLE_WINDOW = {
  id: 'win_1',
  title: 'Test Window',
  processId: 1234,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  isVisible: true,
};

const SAMPLE_ELEMENT = {
  id: 'elem_1',
  name: 'File name:',
  controlType: 'Edit',
  isEnabled: true,
  isVisible: true,
  bounds: { x: 10, y: 10, width: 200, height: 30 },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('NativeUIClient', () => {
  let client: InstanceType<typeof NativeUIClient>;

  beforeEach(() => {
    stdinWrites = [];
    fakeProcess = createFakeProcess();
    vi.mocked(fs.existsSync).mockImplementation((filePath) => String(filePath).endsWith('FlaUIBridge.exe'));
    client = new NativeUIClient();
  });

  afterEach(() => {
    client.stop();
    vi.restoreAllMocks();
  });

  // ─── Lifecycle ───────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should spawn the bundled bridge executable when available', async () => {
      await client.start();

      expect(cp.spawn).toHaveBeenCalledWith(
        expect.stringContaining('FlaUIBridge.exe'),
        [],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('should report isRunning correctly', async () => {
      expect(client.isRunning).toBe(false);

      await client.start();
      expect(client.isRunning).toBe(true);

      client.stop();
      expect(client.isRunning).toBe(false);
    });

    it('should kill the process on stop()', async () => {
      await client.start();
      client.stop();

      expect(fakeProcess.kill).toHaveBeenCalled();
    });
  });

  // ─── Low-level methods ──────────────────────────────────────────

  describe('low-level methods', () => {
    beforeEach(async () => {
      await client.start();
    });

    it('findWindow() should send correct JSON and return result', async () => {
      respondWith(SAMPLE_WINDOW);
      const result = await client.findWindow('Test');

      expect(stdinWrites).toHaveLength(1);
      const sent = JSON.parse(stdinWrites[0]);
      expect(sent).toEqual({ method: 'findWindow', params: { titlePattern: 'Test' } });
      expect(result).toEqual(SAMPLE_WINDOW);
    });

    it('findElement() should send correct JSON with optional controlType', async () => {
      respondWith(SAMPLE_ELEMENT);
      const result = await client.findElement('win_1', 'File name:', 'edit');

      const sent = JSON.parse(stdinWrites[0]);
      expect(sent).toEqual({
        method: 'findElement',
        params: { windowId: 'win_1', name: 'File name:', controlType: 'edit' },
      });
      expect(result).toEqual(SAMPLE_ELEMENT);
    });

    it('findElement() should omit controlType when not provided', async () => {
      respondWith(SAMPLE_ELEMENT);
      await client.findElement('win_1', 'File name:');

      const sent = JSON.parse(stdinWrites[0]);
      expect(sent.params).not.toHaveProperty('controlType');
    });

    it('clickElement() should send correct JSON', async () => {
      respondWith({ success: true });
      await client.clickElement('elem_1');

      const sent = JSON.parse(stdinWrites[0]);
      expect(sent).toEqual({ method: 'clickElement', params: { elementId: 'elem_1' } });
    });

    it('setText() should send correct JSON', async () => {
      respondWith({ success: true });
      await client.setText('elem_1', 'hello.txt');

      const sent = JSON.parse(stdinWrites[0]);
      expect(sent).toEqual({ method: 'setText', params: { elementId: 'elem_1', text: 'hello.txt' } });
    });

    it('focusWindow() should send correct JSON', async () => {
      respondWith({ success: true });
      await client.focusWindow('win_1');

      const sent = JSON.parse(stdinWrites[0]);
      expect(sent).toEqual({ method: 'focusWindow', params: { windowId: 'win_1' } });
    });

    it('resizeWindow() should send correct JSON', async () => {
      respondWith({ success: true });
      await client.resizeWindow('win_1', 1280, 720);

      const sent = JSON.parse(stdinWrites[0]);
      expect(sent).toEqual({
        method: 'resizeWindow',
        params: { windowId: 'win_1', width: 1280, height: 720 },
      });
    });

    it('moveWindow() should send correct JSON', async () => {
      respondWith({ success: true });
      await client.moveWindow('win_1', 100, 200);

      const sent = JSON.parse(stdinWrites[0]);
      expect(sent).toEqual({
        method: 'moveWindow',
        params: { windowId: 'win_1', x: 100, y: 200 },
      });
    });

    it('listWindows() should send correct JSON and return array', async () => {
      respondWith([SAMPLE_WINDOW]);
      const result = await client.listWindows();

      const sent = JSON.parse(stdinWrites[0]);
      expect(sent).toEqual({ method: 'listWindows', params: {} });
      expect(result).toEqual([SAMPLE_WINDOW]);
    });

    it('getElementTree() should send correct JSON', async () => {
      const tree = { element: SAMPLE_ELEMENT, children: [] };
      respondWith(tree);
      const result = await client.getElementTree('win_1');

      const sent = JSON.parse(stdinWrites[0]);
      expect(sent).toEqual({ method: 'getElementTree', params: { windowId: 'win_1' } });
      expect(result).toEqual(tree);
    });
  });

  // ─── Error handling ─────────────────────────────────────────────

  describe('error handling', () => {
    beforeEach(async () => {
      await client.start();
    });

    it('should reject when bridge returns an error response', async () => {
      respondWithError('Element not found');
      await expect(client.findWindow('Missing')).rejects.toThrow('Element not found');
    });

    it('should reject when bridge returns invalid JSON', async () => {
      respondWithRaw('NOT VALID JSON');
      await expect(client.findWindow('Test')).rejects.toThrow('Invalid response');
    });

    it('should reject when bridge is not running', async () => {
      client.stop();
      await expect(client.findWindow('Test')).rejects.toThrow('FlaUI bridge not running');
    });
  });

  // ─── High-level helpers ─────────────────────────────────────────

  describe('handleSaveAsDialog()', () => {
    beforeEach(async () => {
      await client.start();
    });

    it('should find dialog, set filename, and press Enter', async () => {
      const saveWin = { ...SAMPLE_WINDOW, id: 'save_win', title: 'Save As' };
      const fileNameBox = { ...SAMPLE_ELEMENT, id: 'fname_box' };

      // findFileDialog calls listWindows, then findElement to validate
      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([saveWin]);
      vi.spyOn(client, 'findElement').mockResolvedValueOnce(fileNameBox);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'clickElement').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'setText').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'pressKey').mockResolvedValueOnce(undefined);

      await client.handleSaveAsDialog('output.txt');

      expect(client.listWindows).toHaveBeenCalled();
      expect(client.focusWindow).toHaveBeenCalledWith('save_win');
      expect(client.clickElement).toHaveBeenCalledWith('fname_box');
      expect(client.setText).toHaveBeenCalledWith('fname_box', 'output.txt');
      expect(client.pressKey).toHaveBeenCalledWith('enter');
    });

    it('should skip windows that lack "File name:" edit (false positives)', async () => {
      // A window title containing "Save As" that is NOT a real Save dialog
      const fakeWin = { ...SAMPLE_WINDOW, id: 'fake', title: 'Save As draft - VS Code' };
      const realWin = { ...SAMPLE_WINDOW, id: 'save_win', title: 'Save As' };
      const fileNameBox = { ...SAMPLE_ELEMENT, id: 'fname_box' };

      // Both windows match the "Save As" pattern, but only realWin has the edit field
      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([fakeWin, realWin]);
      vi.spyOn(client, 'findElement')
        .mockResolvedValueOnce(null)            // fakeWin: no "File name:" edit
        .mockResolvedValueOnce(fileNameBox);    // realWin: "File name:" edit found
      vi.spyOn(client, 'focusWindow').mockResolvedValue(undefined);
      vi.spyOn(client, 'clickElement').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'setText').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'pressKey').mockResolvedValueOnce(undefined);

      await client.handleSaveAsDialog('output.txt');

      expect(client.setText).toHaveBeenCalledWith('fname_box', 'output.txt');
    });

    it('should throw when dialog is not found within timeout', async () => {
      vi.spyOn(client, 'listWindows').mockResolvedValue([]);

      await expect(client.handleSaveAsDialog('output.txt', 100)).rejects.toThrow(
        'Save As dialog not found',
      );
    });
  });

  describe('handleOpenDialog()', () => {
    beforeEach(async () => {
      await client.start();
    });

    it('should find dialog, set filename, and press Enter', async () => {
      const openWin = { ...SAMPLE_WINDOW, id: 'open_win', title: 'Open' };
      const fileNameBox = { ...SAMPLE_ELEMENT, id: 'fname_box' };

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([openWin]);
      vi.spyOn(client, 'findElement').mockResolvedValueOnce(fileNameBox);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'clickElement').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'setText').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'pressKey').mockResolvedValueOnce(undefined);

      await client.handleOpenDialog('data.csv');

      expect(client.listWindows).toHaveBeenCalled();
      expect(client.focusWindow).toHaveBeenCalledWith('open_win');
      expect(client.clickElement).toHaveBeenCalledWith('fname_box');
      expect(client.setText).toHaveBeenCalledWith('fname_box', 'data.csv');
      expect(client.pressKey).toHaveBeenCalledWith('enter');
    });

    it('should throw when dialog is not found within timeout', async () => {
      vi.spyOn(client, 'listWindows').mockResolvedValue([]);

      await expect(client.handleOpenDialog('data.csv', 100)).rejects.toThrow(
        'Open dialog not found',
      );
    });
  });

  describe('clickDialogButton()', () => {
    beforeEach(async () => {
      await client.start();
    });

    it('should find dialog with matching button and click it', async () => {
      const dialog = { ...SAMPLE_WINDOW, id: 'dlg_1', title: 'Confirm' };
      const okBtn = { ...SAMPLE_ELEMENT, id: 'ok_btn', name: 'OK', controlType: 'Button' };

      // clickDialogButton now uses listWindows + findElement to validate
      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([dialog]);
      vi.spyOn(client, 'findElement').mockResolvedValueOnce(okBtn);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'clickElement').mockResolvedValueOnce(undefined);

      await client.clickDialogButton('Confirm', 'OK');

      expect(client.listWindows).toHaveBeenCalled();
      expect(client.findElement).toHaveBeenCalledWith('dlg_1', 'OK', 'button');
      expect(client.focusWindow).toHaveBeenCalledWith('dlg_1');
      expect(client.clickElement).toHaveBeenCalledWith('ok_btn');
    });

    it('should skip windows where button is not found', async () => {
      const fakeWin = { ...SAMPLE_WINDOW, id: 'fake', title: 'Confirm something' };
      const realWin = { ...SAMPLE_WINDOW, id: 'dlg_1', title: 'Confirm' };
      const okBtn = { ...SAMPLE_ELEMENT, id: 'ok_btn', name: 'OK', controlType: 'Button' };

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([fakeWin, realWin]);
      vi.spyOn(client, 'findElement')
        .mockResolvedValueOnce(null)    // fake window: no OK button
        .mockResolvedValueOnce(okBtn);  // real dialog: OK button found
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'clickElement').mockResolvedValueOnce(undefined);

      await client.clickDialogButton('Confirm', 'OK');

      expect(client.clickElement).toHaveBeenCalledWith('ok_btn');
    });

    it('should throw when no matching dialog is found within timeout', async () => {
      vi.spyOn(client, 'listWindows').mockResolvedValue([]);

      await expect(client.clickDialogButton('Confirm', 'Missing', 100)).rejects.toThrow(
        'Dialog "Confirm" not found',
      );
    });
  });

  describe('clickInDevHost()', () => {
    beforeEach(async () => {
      await client.start();
    });

    it('should find Dev Host window, find element, and click', async () => {
      const devWin = { ...SAMPLE_WINDOW, id: 'dev_win', title: 'Extension Development Host' };
      const el = { ...SAMPLE_ELEMENT, id: 'el_1', name: 'Submit' };

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([devWin]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'findElement').mockResolvedValueOnce(el);
      vi.spyOn(client, 'clickElement').mockResolvedValueOnce(undefined);

      await client.clickInDevHost('Submit');

      expect(client.listWindows).toHaveBeenCalled();
      expect(client.focusWindow).toHaveBeenCalledWith('dev_win');
      expect(client.findElement).toHaveBeenCalledWith('dev_win', 'Submit', undefined);
      expect(client.clickElement).toHaveBeenCalledWith('el_1');
    });

    it('should throw when element is not found in Dev Host', async () => {
      const devWin = { ...SAMPLE_WINDOW, id: 'dev_win', title: 'Extension Development Host' };

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([devWin]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'findElement').mockResolvedValueOnce(null);

      await expect(client.clickInDevHost('Missing')).rejects.toThrow(
        'Element "Missing" not found in Dev Host window',
      );
    });
  });

  // ─── Dev Host helpers ───────────────────────────────────────────

  describe('Dev Host helpers', () => {
    beforeEach(async () => {
      await client.start();
    });

    it('resizeDevHost() should find Dev Host window and resize', async () => {
      const devWin = { ...SAMPLE_WINDOW, id: 'dev_win', title: 'Extension Development Host' };

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([devWin]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'resizeWindow').mockResolvedValueOnce(undefined);

      await client.resizeDevHost(1280, 720);

      expect(client.focusWindow).toHaveBeenCalledWith('dev_win');
      expect(client.resizeWindow).toHaveBeenCalledWith('dev_win', 1280, 720);
    });

    it('moveDevHost() should find Dev Host window and move', async () => {
      const devWin = { ...SAMPLE_WINDOW, id: 'dev_win', title: 'Extension Development Host' };

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([devWin]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'moveWindow').mockResolvedValueOnce(undefined);

      await client.moveDevHost(100, 200);

      expect(client.focusWindow).toHaveBeenCalledWith('dev_win');
      expect(client.moveWindow).toHaveBeenCalledWith('dev_win', 100, 200);
    });

    it('findDevHostWindow should match by partial title', async () => {
      const devWin = {
        ...SAMPLE_WINDOW,
        id: 'dev_win',
        title: 'test-project - Extension Development Host',
      };

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([devWin]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'resizeWindow').mockResolvedValueOnce(undefined);

      await client.resizeDevHost(800, 600);

      expect(client.listWindows).toHaveBeenCalled();
      expect(client.resizeWindow).toHaveBeenCalledWith('dev_win', 800, 600);
    });
  });

  // ─── PID-based window disambiguation ────────────────────────────

  describe('targetPid filtering', () => {
    const f5Window = {
      ...SAMPLE_WINDOW,
      id: 'f5_win',
      title: 'my-ext - Extension Development Host',
      processId: 1000,
    };
    const launchedWindow = {
      ...SAMPLE_WINDOW,
      id: 'launched_win',
      title: 'my-ext - Extension Development Host',
      processId: 2000,
    };

    beforeEach(async () => {
      await client.start();
    });

    it('should pick first window when no targetPid is set', async () => {
      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([f5Window, launchedWindow]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'resizeWindow').mockResolvedValueOnce(undefined);

      await client.resizeDevHost(800, 600);

      // Without targetPid, grabs the first match
      expect(client.focusWindow).toHaveBeenCalledWith('f5_win');
    });

    it('should pick the window matching targetPid process tree when set', async () => {
      client.targetPid = 1999; // parent of launchedWindow (processId 2000)

      // Mock wmic to return a process tree where 2000 is a child of 1999
      (cp.execSync as any).mockReturnValue(
        'Node,ParentProcessId,ProcessId\n' +
        'PC,0,1\n' +
        'PC,1,1000\n' +
        'PC,1999,2000\n'
      );

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([f5Window, launchedWindow]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'resizeWindow').mockResolvedValueOnce(undefined);

      await client.resizeDevHost(800, 600);

      // Should pick launched_win (PID 2000), not f5_win (PID 1000)
      expect(client.focusWindow).toHaveBeenCalledWith('launched_win');
      expect(client.resizeWindow).toHaveBeenCalledWith('launched_win', 800, 600);
    });

    it('should fall back to first window when targetPid has no matching descendants', async () => {
      client.targetPid = 9999; // no children in the tree

      (cp.execSync as any).mockReturnValue(
        'Node,ParentProcessId,ProcessId\n' +
        'PC,0,1\n' +
        'PC,1,1000\n' +
        'PC,1,2000\n'
      );

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([f5Window, launchedWindow]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'resizeWindow').mockResolvedValueOnce(undefined);

      await client.resizeDevHost(800, 600);

      // Falls back to first match
      expect(client.focusWindow).toHaveBeenCalledWith('f5_win');
    });

    it('should not filter by PID when only one Dev Host window exists', async () => {
      client.targetPid = 1999;

      (cp.execSync as any).mockReturnValue(
        'Node,ParentProcessId,ProcessId\n' +
        'PC,1999,2000\n'
      );

      // Only one window — no ambiguity, PID filter is skipped
      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([launchedWindow]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'resizeWindow').mockResolvedValueOnce(undefined);

      await client.resizeDevHost(800, 600);

      expect(client.focusWindow).toHaveBeenCalledWith('launched_win');
    });

    it('should handle wmic failure gracefully and fall back to first window', async () => {
      client.targetPid = 1999;

      (cp.execSync as any).mockImplementation(() => {
        throw new Error('wmic not found');
      });

      vi.spyOn(client, 'listWindows').mockResolvedValueOnce([f5Window, launchedWindow]);
      vi.spyOn(client, 'focusWindow').mockResolvedValueOnce(undefined);
      vi.spyOn(client, 'resizeWindow').mockResolvedValueOnce(undefined);

      await client.resizeDevHost(800, 600);

      // wmic failed, so allowedPids only contains targetPid (1999) — no match,
      // falls back to first window
      expect(client.focusWindow).toHaveBeenCalledWith('f5_win');
    });
  });
});
