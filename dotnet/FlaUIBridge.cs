using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;
using FlaUI.UIA3;

namespace FlaUIBridge
{
    /// <summary>
    /// Bridge class exposing FlaUI functionality to Node.js via edge-js.
    /// Each public method follows the edge-js async pattern: Task<object> Method(dynamic input).
    /// </summary>
    public class Automation
    {
        private const int SW_RESTORE = 9;
        private static readonly UIA3Automation _automation = new();
        private static readonly Dictionary<string, AutomationElement> _elementCache = new();
        private static int _elementIdCounter = 0;

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetWindowDC(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hWnd);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool BitBlt(IntPtr destHdc, int destX, int destY, int width, int height, IntPtr srcHdc, int srcX, int srcY, int rop);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool DeleteObject(IntPtr obj);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool DeleteDC(IntPtr hdc);

        private const int SRCCOPY = 0x00CC0020;
        private const uint MONITOR_DEFAULTTONEAREST = 2;

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public int dwFlags;
        }

        private sealed class CaptureContext
        {
            public required IntPtr Hwnd { get; init; }
            public required int X { get; init; }
            public required int Y { get; init; }
            public required int Width { get; init; }
            public required int Height { get; init; }
            public required object Target { get; init; }
            public required object? ForegroundBefore { get; init; }
            public required object? ForegroundAfter { get; init; }
            public required object? Monitor { get; init; }
            public required uint? Dpi { get; init; }
            public required object Expected { get; init; }
        }

        /// <summary>
        /// Find a window by title pattern (partial match).
        /// Input: { titlePattern: string, timeoutMs?: int }
        /// </summary>
        public async Task<object?> FindWindow(dynamic input)
        {
            string titlePattern = (string)input.titlePattern;
            var desktop = _automation.GetDesktop();
            var windows = desktop.FindAllChildren(
                cf => cf.ByControlType(ControlType.Window));

            foreach (var window in windows)
            {
                if (window.Name?.Contains(titlePattern, StringComparison.OrdinalIgnoreCase) == true)
                {
                    return CacheAndSerializeWindow(window);
                }
            }

            return null;
        }

        /// <summary>
        /// Find a UI element within a window by name and optional control type.
        /// Input: { windowId: string, name: string, controlType?: string }
        /// </summary>
        public async Task<object?> FindElement(dynamic input)
        {
            string windowId = (string)input.windowId;
            string name = (string)input.name;
            string? controlType = input.controlType as string;

            if (!_elementCache.TryGetValue(windowId, out var window))
                return null;

            ConditionBase condition;
            if (!string.IsNullOrEmpty(controlType))
            {
                var ct = ParseControlType(controlType);
                condition = new AndCondition(
                    new PropertyCondition(_automation.PropertyLibrary.Element.Name, name),
                    new PropertyCondition(_automation.PropertyLibrary.Element.ControlType, ct));
            }
            else
            {
                condition = new PropertyCondition(
                    _automation.PropertyLibrary.Element.Name, name);
            }

            var element = window.FindFirstDescendant(condition);
            if (element == null) return null;

            return CacheAndSerializeElement(element);
        }

        /// <summary>
        /// Click a UI element by cached ID.
        /// Input: { elementId: string }
        /// </summary>
        public async Task<object> ClickElement(dynamic input)
        {
            string elementId = (string)input.elementId;
            if (!_elementCache.TryGetValue(elementId, out var element))
                throw new Exception($"Element {elementId} not found in cache");

            var point = GetClickableCenter(element);
            var button = ParseMouseButton(input.button as string);
            int clickCount = NormalizeClickCount((int)input.clickCount);

            ClickAt(point, button, clickCount);
            await Task.Delay(100);
            return new { success = true };
        }

        /// <summary>
        /// Move the OS mouse cursor to screen coordinates.
        /// Input: { x: double, y: double }
        /// </summary>
        public async Task<object> MoveMouse(dynamic input)
        {
            var point = new Point(Convert.ToInt32((double)input.x), Convert.ToInt32((double)input.y));
            Mouse.MoveTo(point);
            await Task.Delay(50);
            return new { success = true };
        }

        /// <summary>
        /// Click at screen coordinates, or at the current cursor position if x/y are omitted.
        /// Input: { x?: double, y?: double, button?: string, clickCount?: int }
        /// </summary>
        public async Task<object> ClickMouse(dynamic input)
        {
            var button = ParseMouseButton(input.button as string);
            int clickCount = NormalizeClickCount((int)input.clickCount);

            object? rawX = input.x;
            object? rawY = input.y;
            if (rawX == null || rawY == null)
            {
                Click(button, clickCount);
            }
            else
            {
                var point = new Point(
                    Convert.ToInt32(Convert.ToDouble(rawX)),
                    Convert.ToInt32(Convert.ToDouble(rawY)));
                ClickAt(point, button, clickCount);
            }

            await Task.Delay(100);
            return new { success = true };
        }

        /// <summary>
        /// Find all items in the currently visible popup menu / list overlay.
        /// Searches for MenuItem, ListItem, and TreeItem descendants of Menu,
        /// List, and Tree containers that are NOT offscreen.
        /// Input: { windowId: string }
        /// </summary>
        public async Task<object> FindPopupItems(dynamic input)
        {
            string windowId = (string)input.windowId;
            if (!_elementCache.TryGetValue(windowId, out var window))
                throw new Exception($"Window {windowId} not found in cache");

            var items = new List<object>();

            // Search for visible popup containers (Menu, List, Tree, ComboBox dropdowns)
            var containerTypes = new[] { ControlType.Menu, ControlType.List, ControlType.Tree };
            foreach (var ct in containerTypes)
            {
                var containers = window.FindAllDescendants(
                    new PropertyCondition(_automation.PropertyLibrary.Element.ControlType, ct));

                foreach (var container in containers)
                {
                    if (container.Properties.IsOffscreen.ValueOrDefault) continue;

                    // Check for a reasonably small bounding rect (popup, not the whole window)
                    var cRect = container.BoundingRectangle;
                    if (cRect.Width <= 0 || cRect.Height <= 0) continue;

                    var childTypes = new[] { ControlType.MenuItem, ControlType.ListItem, ControlType.TreeItem };
                    foreach (var childType in childTypes)
                    {
                        var children = container.FindAllDescendants(
                            new PropertyCondition(_automation.PropertyLibrary.Element.ControlType, childType));

                        foreach (var child in children)
                        {
                            if (child.Properties.IsOffscreen.ValueOrDefault) continue;
                            var name = child.Name;
                            if (string.IsNullOrEmpty(name)) continue;
                            items.Add(CacheAndSerializeElement(child));
                        }
                    }
                }
            }

            return items.ToArray();
        }

        /// <summary>
        /// Select an item from a popup menu/list by name (partial match).
        /// Searches MenuItem, ListItem, and TreeItem descendants, clicks the
        /// first match whose Name contains the search text.
        /// Input: { windowId: string, itemName: string }
        /// </summary>
        public async Task<object> SelectPopupItem(dynamic input)
        {
            string windowId = (string)input.windowId;
            string itemName = (string)input.itemName;

            if (!_elementCache.TryGetValue(windowId, out var window))
                throw new Exception($"Window {windowId} not found in cache");

            // Search all interactive item types that could be popup choices
            var itemTypes = new[] { ControlType.MenuItem, ControlType.ListItem, ControlType.TreeItem };

            foreach (var itemType in itemTypes)
            {
                var candidates = window.FindAllDescendants(
                    new PropertyCondition(_automation.PropertyLibrary.Element.ControlType, itemType));

                foreach (var candidate in candidates)
                {
                    if (candidate.Properties.IsOffscreen.ValueOrDefault) continue;
                    var name = candidate.Name;
                    if (string.IsNullOrEmpty(name)) continue;

                    if (name.Contains(itemName, StringComparison.OrdinalIgnoreCase))
                    {
                        var point = GetClickableCenter(candidate);
                        ClickAt(point, MouseButton.Left, 1);
                        await Task.Delay(100);
                        return new { success = true, selected = name };
                    }
                }
            }

            throw new Exception(
                $"Popup item containing \"{itemName}\" not found. " +
                $"Use findPopupItems to see available items.");
        }

        /// <summary>
        /// Press a keyboard key (e.g. Enter, Escape, Tab).
        /// Input: { key: string }
        /// </summary>
        public async Task<object> PressKey(dynamic input)
        {
            string key = (string)input.key;

            if (key.Contains(' '))
            {
                throw new ArgumentException($"Multi-stroke key chords are not supported by the native bridge: {key}");
            }

            var parts = key.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length == 0) throw new ArgumentException("Key cannot be empty");

            var modifiers = new List<VirtualKeyShort>();
            string mainKey = parts[^1];
            for (int i = 0; i < parts.Length - 1; i++)
            {
                modifiers.Add(ParseModifier(parts[i]));
            }

            var vk = ParseVirtualKey(mainKey);

            foreach (var modifier in modifiers) Keyboard.Press(modifier);
            Keyboard.Press(vk);
            await Task.Delay(50); // brief settle time
            Keyboard.Release(vk);
            for (int i = modifiers.Count - 1; i >= 0; i--) Keyboard.Release(modifiers[i]);
            return new { success = true };
        }

        /// <summary>
        /// Set text in a text field element.
        /// Input: { elementId: string, text: string }
        /// </summary>
        public async Task<object> SetText(dynamic input)
        {
            string elementId = (string)input.elementId;
            string text = (string)input.text;

            if (!_elementCache.TryGetValue(elementId, out var element))
                throw new Exception($"Element {elementId} not found in cache");

            var textBox = element.AsTextBox();
            textBox.Text = text;
            return new { success = true };
        }

        /// <summary>
        /// Get the accessibility tree of a window.
        /// Input: { windowId: string }
        /// </summary>
        public async Task<object> GetElementTree(dynamic input)
        {
            string windowId = (string)input.windowId;
            if (!_elementCache.TryGetValue(windowId, out var window))
                throw new Exception($"Window {windowId} not found in cache");

            return BuildTree(window, maxDepth: 5);
        }

        /// <summary>
        /// List all top-level windows.
        /// Input: null
        /// </summary>
        public async Task<object> ListWindows(dynamic input)
        {
            bool includeOffscreen = input?.includeOffscreen == true;
            var desktop = _automation.GetDesktop();
            var windows = desktop.FindAllChildren(
                cf => cf.ByControlType(ControlType.Window));

            return windows
                .Where(w => !string.IsNullOrEmpty(w.Name) && (includeOffscreen || w.Properties.IsOffscreen.ValueOrDefault == false))
                .Select(w => CacheAndSerializeWindow(w))
                .ToArray();
        }

        /// <summary>
        /// Bring a window to the foreground.
        /// Input: { windowId: string }
        /// </summary>
        public async Task<object> FocusWindow(dynamic input)
        {
            string windowId = (string)input.windowId;
            if (!_elementCache.TryGetValue(windowId, out var element))
                throw new Exception($"Window {windowId} not found in cache");

            var window = element.AsWindow();
            window.SetForeground();
            return new { success = true };
        }

        /// <summary>
        /// Resize a window to the given dimensions.
        /// Input: { windowId: string, width: double, height: double }
        /// </summary>
        public async Task<object> ResizeWindow(dynamic input)
        {
            string windowId = (string)input.windowId;
            double width = (double)input.width;
            double height = (double)input.height;

            if (width <= 0 || height <= 0)
                throw new Exception($"Invalid dimensions: width={width}, height={height} (must be positive)");

            if (!_elementCache.TryGetValue(windowId, out var element))
                throw new Exception($"Window {windowId} not found in cache");

            var window = element.AsWindow();
            if (!window.Patterns.Transform.IsSupported)
                throw new Exception($"Window does not support resize (Transform pattern unavailable). It may be maximized or a system window.");

            window.Patterns.Transform.Pattern.Resize(width, height);
            return new { success = true };
        }

        /// <summary>
        /// Move a window to the given screen coordinates.
        /// Input: { windowId: string, x: double, y: double }
        /// </summary>
        public async Task<object> MoveWindow(dynamic input)
        {
            string windowId = (string)input.windowId;
            double x = (double)input.x;
            double y = (double)input.y;

            if (!_elementCache.TryGetValue(windowId, out var element))
                throw new Exception($"Window {windowId} not found in cache");

            var window = element.AsWindow();
            if (!window.Patterns.Transform.IsSupported)
                throw new Exception($"Window does not support move (Transform pattern unavailable). It may be maximized or a system window.");

            window.Patterns.Transform.Pattern.Move(x, y);
            return new { success = true };
        }

        /// <summary>
        /// Capture a cached window's current bounds to a PNG file.
        /// Input: { windowId: string, filePath: string }
        /// </summary>
        public async Task<object> CaptureWindowScreenshot(dynamic input)
        {
            string windowId = (string)input.windowId;
            string filePath = (string)input.filePath;
            int? expectedProcessId = input.expectedProcessId == null ? null : Convert.ToInt32(input.expectedProcessId);
            string? expectedTitle = input.expectedTitle as string;
            string? expectedWindowHandle = input.expectedWindowHandle as string;

            if (!_elementCache.TryGetValue(windowId, out var element))
                throw new Exception($"Window {windowId} not found in cache");

            var attempts = new List<object>();
            var warnings = new List<string>();
            Exception? lastError = null;

            for (int attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    var capture = await PrepareCapture(element, expectedProcessId, expectedTitle, expectedWindowHandle, warnings);
                    if (!IsSameHwnd(GetForegroundWindow(), capture.Hwnd))
                    {
                        throw new Exception($"Foreground window after focus is {FormatHwnd(GetForegroundWindow())}, expected target {FormatHwnd(capture.Hwnd)}; skipped CopyFromScreen to avoid capturing the wrong window");
                    }
                    SaveCopyFromScreen(capture.X, capture.Y, capture.Width, capture.Height, filePath);
                    attempts.Add(new { attempt, strategy = "CopyFromScreen", success = true });
                    return CaptureSuccess(filePath, capture, "CopyFromScreen", attempts, warnings);
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    attempts.Add(new { attempt, strategy = "CopyFromScreen", success = false, message = ex.Message });
                    warnings.Add($"CopyFromScreen attempt {attempt} failed: {ex.Message}");
                    await Task.Delay(150 * attempt);
                }
            }

            var nativeHandle = element.Properties.NativeWindowHandle.ValueOrDefault;
            if (nativeHandle != 0)
            {
                try
                {
                    var capture = await PrepareCapture(element, expectedProcessId, expectedTitle, expectedWindowHandle, warnings);
                    SaveWindowDcBitBlt(capture.Hwnd, capture.Width, capture.Height, filePath);
                    attempts.Add(new { attempt = 4, strategy = "WindowDC-BitBlt", success = true });
                    warnings.Add("Used WindowDC BitBlt fallback after CopyFromScreen failures.");
                    return CaptureSuccess(filePath, capture, "WindowDC-BitBlt", attempts, warnings);
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    attempts.Add(new { attempt = 4, strategy = "WindowDC-BitBlt", success = false, message = ex.Message });
                    warnings.Add($"WindowDC BitBlt fallback failed: {ex.Message}");
                }

                try
                {
                    var capture = await PrepareCapture(element, expectedProcessId, expectedTitle, expectedWindowHandle, warnings);
                    SavePrintWindow(capture.Hwnd, capture.Width, capture.Height, filePath);
                    attempts.Add(new { attempt = 5, strategy = "PrintWindow", success = true });
                    warnings.Add("Used PrintWindow fallback after CopyFromScreen and WindowDC BitBlt failures; Chromium content can render blank on some systems.");
                    return CaptureSuccess(filePath, capture, "PrintWindow", attempts, warnings);
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    attempts.Add(new { attempt = 5, strategy = "PrintWindow", success = false, message = ex.Message });
                    warnings.Add($"PrintWindow fallback failed: {ex.Message}");
                }
            }

            throw new Exception($"Screenshot capture failed after retries: {lastError?.Message}; attempts: {string.Join(" | ", attempts.Select(a => a.ToString()))}", lastError);
        }

        private static async Task<CaptureContext> PrepareCapture(AutomationElement element, int? expectedProcessId, string? expectedTitle, string? expectedWindowHandle, List<string> warnings)
        {
            var window = element.AsWindow();
            var nativeHandle = element.Properties.NativeWindowHandle.ValueOrDefault;
            if (nativeHandle == 0) throw new Exception("Target window has no native HWND; cannot validate screenshot target");
            var hwnd = new IntPtr(nativeHandle);
            var foregroundBefore = GetWindowInfo(GetForegroundWindow());
            ValidateTargetWindow(hwnd, expectedProcessId, expectedTitle, expectedWindowHandle, warnings);

            if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
            window.SetForeground();
            await Task.Delay(200);
            ValidateTargetWindow(hwnd, expectedProcessId, expectedTitle, expectedWindowHandle, warnings);

            if (element.Properties.IsOffscreen.ValueOrDefault)
                throw new Exception("Window is minimized or offscreen after restore; cannot capture screenshot");

            var bounds = GetWindowBounds(hwnd) ?? RectToObject(element.BoundingRectangle.X, element.BoundingRectangle.Y, element.BoundingRectangle.Width, element.BoundingRectangle.Height);
            dynamic dynamicBounds = bounds;
            int x = Convert.ToInt32(Math.Round(Convert.ToDouble(dynamicBounds.x)));
            int y = Convert.ToInt32(Math.Round(Convert.ToDouble(dynamicBounds.y)));
            int width = Convert.ToInt32(Math.Round(Convert.ToDouble(dynamicBounds.width)));
            int height = Convert.ToInt32(Math.Round(Convert.ToDouble(dynamicBounds.height)));
            if (width <= 0 || height <= 0)
                throw new Exception($"Window has invalid screenshot bounds: x={x}, y={y}, width={width}, height={height}");

            return new CaptureContext
            {
                Hwnd = hwnd,
                X = x,
                Y = y,
                Width = width,
                Height = height,
                Target = GetWindowInfo(hwnd)!,
                ForegroundBefore = foregroundBefore,
                ForegroundAfter = GetWindowInfo(GetForegroundWindow()),
                Monitor = GetMonitorMetadata(hwnd),
                Dpi = TryGetDpi(hwnd),
                Expected = new { hwnd = expectedWindowHandle, processId = expectedProcessId, title = expectedTitle }
            };
        }

        private static void SaveCopyFromScreen(int x, int y, int width, int height, string filePath)
        {
            using var bitmap = new Bitmap(width, height);
            using var graphics = Graphics.FromImage(bitmap);
            graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height));
            ValidateBitmapHasSignal(bitmap, "CopyFromScreen");
            SavePngAtomically(bitmap, filePath);
        }

        private static void SavePrintWindow(IntPtr hwnd, int width, int height, string filePath)
        {
            using var bitmap = new Bitmap(width, height);
            using var graphics = Graphics.FromImage(bitmap);
            var hdc = graphics.GetHdc();
            try
            {
                if (!PrintWindow(hwnd, hdc, 2))
                    throw new Exception("PrintWindow returned false");
            }
            finally
            {
                graphics.ReleaseHdc(hdc);
            }
            ValidateBitmapHasSignal(bitmap, "PrintWindow");
            SavePngAtomically(bitmap, filePath);
        }

        private static void SaveWindowDcBitBlt(IntPtr hwnd, int width, int height, string filePath)
        {
            IntPtr sourceDc = IntPtr.Zero;
            IntPtr memoryDc = IntPtr.Zero;
            IntPtr bitmapHandle = IntPtr.Zero;
            IntPtr previousObject = IntPtr.Zero;
            try
            {
                sourceDc = GetWindowDC(hwnd);
                if (sourceDc == IntPtr.Zero) throw Win32Exception("GetWindowDC failed");
                memoryDc = CreateCompatibleDC(sourceDc);
                if (memoryDc == IntPtr.Zero) throw Win32Exception("CreateCompatibleDC failed");
                bitmapHandle = CreateCompatibleBitmap(sourceDc, width, height);
                if (bitmapHandle == IntPtr.Zero) throw Win32Exception("CreateCompatibleBitmap failed");
                previousObject = SelectObject(memoryDc, bitmapHandle);
                if (previousObject == IntPtr.Zero) throw Win32Exception("SelectObject failed");
                if (!BitBlt(memoryDc, 0, 0, width, height, sourceDc, 0, 0, SRCCOPY)) throw Win32Exception("BitBlt failed");
                using var bitmap = Image.FromHbitmap(bitmapHandle);
                ValidateBitmapHasSignal(bitmap, "WindowDC-BitBlt");
                SavePngAtomically(bitmap, filePath);
            }
            finally
            {
                if (previousObject != IntPtr.Zero && memoryDc != IntPtr.Zero) SelectObject(memoryDc, previousObject);
                if (bitmapHandle != IntPtr.Zero) DeleteObject(bitmapHandle);
                if (memoryDc != IntPtr.Zero) DeleteDC(memoryDc);
                if (sourceDc != IntPtr.Zero) ReleaseDC(hwnd, sourceDc);
            }
        }

        private static void SavePngAtomically(Image bitmap, string filePath)
        {
            var directory = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var tempPath = filePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using var stream = new MemoryStream();
                bitmap.Save(stream, ImageFormat.Png);
                var bytes = stream.ToArray();
                if (bytes.Length == 0) throw new Exception("Screenshot PNG encoder produced no bytes");
                File.WriteAllBytes(tempPath, bytes);
                if (new FileInfo(tempPath).Length == 0) throw new Exception("Screenshot file was empty after write");
                File.Move(tempPath, filePath, overwrite: true);
            }
            finally
            {
                try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { /* best effort */ }
            }
        }

        private static void ValidateBitmapHasSignal(Bitmap bitmap, string strategy)
        {
            if (bitmap.Width <= 0 || bitmap.Height <= 0) throw new Exception($"{strategy} produced an invalid bitmap size: {bitmap.Width}x{bitmap.Height}");

            int sampleColumns = Math.Min(24, bitmap.Width);
            int sampleRows = Math.Min(24, bitmap.Height);
            int minLuminance = 255;
            int maxLuminance = 0;
            int distinctBuckets = 0;
            var buckets = new HashSet<int>();

            for (int row = 0; row < sampleRows; row++)
            {
                int y = sampleRows == 1 ? 0 : (int)Math.Round(row * (bitmap.Height - 1) / (double)(sampleRows - 1));
                for (int col = 0; col < sampleColumns; col++)
                {
                    int x = sampleColumns == 1 ? 0 : (int)Math.Round(col * (bitmap.Width - 1) / (double)(sampleColumns - 1));
                    var pixel = bitmap.GetPixel(x, y);
                    int luminance = (pixel.R * 299 + pixel.G * 587 + pixel.B * 114) / 1000;
                    minLuminance = Math.Min(minLuminance, luminance);
                    maxLuminance = Math.Max(maxLuminance, luminance);
                    buckets.Add((pixel.R / 16 << 8) | (pixel.G / 16 << 4) | (pixel.B / 16));
                }
            }

            distinctBuckets = buckets.Count;
            if (maxLuminance - minLuminance < 4 || distinctBuckets < 2)
            {
                throw new Exception($"{strategy} produced a visually blank or uniform screenshot (sampled luminance range {minLuminance}-{maxLuminance}, colorBuckets={distinctBuckets})");
            }
        }

        private static object CaptureSuccess(string filePath, CaptureContext capture, string strategy, List<object> attempts, List<string> warnings)
        {
            var foregroundAtCapture = GetWindowInfo(GetForegroundWindow());
            var metadata = new
            {
                expected = capture.Expected,
                target = capture.Target,
                foregroundBefore = capture.ForegroundBefore,
                foregroundAfter = capture.ForegroundAfter,
                foregroundAtCapture,
                bounds = RectToObject(capture.X, capture.Y, capture.Width, capture.Height),
                monitor = capture.Monitor,
                dpi = capture.Dpi,
                validation = new
                {
                    targetMatchesForegroundAfterFocus = IsSameWindowInfo(capture.Target, capture.ForegroundAfter),
                    targetMatchesForegroundAtCapture = IsSameWindowInfo(capture.Target, foregroundAtCapture),
                }
            };
            return new
            {
                success = true,
                filePath,
                width = capture.Width,
                height = capture.Height,
                strategy,
                attempts = attempts.ToArray(),
                warnings = warnings.Distinct().ToArray(),
                metadata,
            };
        }

        private static void ValidateTargetWindow(IntPtr hwnd, int? expectedProcessId, string? expectedTitle, string? expectedWindowHandle, List<string> warnings)
        {
            var actualProcessId = GetWindowProcessId(hwnd);
            var actualTitle = GetWindowTitle(hwnd);
            var actualHandle = FormatHwnd(hwnd);

            if (!string.IsNullOrEmpty(expectedWindowHandle) && !string.Equals(expectedWindowHandle, actualHandle, StringComparison.OrdinalIgnoreCase))
            {
                throw new Exception($"Screenshot target HWND mismatch: expected {expectedWindowHandle}, actual {actualHandle}");
            }
            if (expectedProcessId.HasValue && actualProcessId != expectedProcessId.Value)
            {
                throw new Exception($"Screenshot target process mismatch: expected pid {expectedProcessId.Value}, actual pid {actualProcessId}");
            }
            if (!string.IsNullOrWhiteSpace(expectedTitle) && !actualTitle.Contains(expectedTitle, StringComparison.OrdinalIgnoreCase))
            {
                warnings.Add($"Screenshot target title changed after discovery. Expected to contain \"{expectedTitle}\", actual \"{actualTitle}\".");
            }
        }

        private static object? GetWindowInfo(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return null;
            return new
            {
                hwnd = FormatHwnd(hwnd),
                processId = GetWindowProcessId(hwnd),
                title = GetWindowTitle(hwnd),
                bounds = GetWindowBounds(hwnd),
            };
        }

        private static bool IsSameWindowInfo(object? left, object? right)
        {
            if (left == null || right == null) return false;
            dynamic l = left;
            dynamic r = right;
            return string.Equals((string)l.hwnd, (string)r.hwnd, StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsSameHwnd(IntPtr left, IntPtr right)
        {
            return left != IntPtr.Zero && left == right;
        }

        private static string FormatHwnd(IntPtr hwnd)
        {
            return $"0x{hwnd.ToInt64():X}";
        }

        private static int GetWindowProcessId(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return 0;
            GetWindowThreadProcessId(hwnd, out var processId);
            return unchecked((int)processId);
        }

        private static string GetWindowTitle(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return "";
            var length = Math.Max(GetWindowTextLength(hwnd), 0);
            var builder = new StringBuilder(length + 1);
            _ = GetWindowText(hwnd, builder, builder.Capacity);
            return builder.ToString();
        }

        private static object? GetWindowBounds(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out var rect)) return null;
            return RectToObject(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
        }

        private static object RectToObject(double x, double y, double width, double height)
        {
            return new { x, y, width, height };
        }

        private static object RectToObject(RECT rect)
        {
            return RectToObject(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
        }

        private static object? GetMonitorMetadata(IntPtr hwnd)
        {
            try
            {
                var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                if (monitor == IntPtr.Zero) return null;
                var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
                if (!GetMonitorInfo(monitor, ref info)) return null;
                return new
                {
                    handle = FormatHwnd(monitor),
                    bounds = RectToObject(info.rcMonitor),
                    workArea = RectToObject(info.rcWork),
                    flags = info.dwFlags,
                };
            }
            catch
            {
                return null;
            }
        }

        private static uint? TryGetDpi(IntPtr hwnd)
        {
            try { return hwnd == IntPtr.Zero ? null : GetDpiForWindow(hwnd); }
            catch { return null; }
        }

        private static Exception Win32Exception(string message)
        {
            return new Exception($"{message}; Win32Error={Marshal.GetLastWin32Error()}");
        }

        // ─── Helpers ─────────────────────────────────────────────────

        private static object CacheAndSerializeWindow(AutomationElement window)
        {
            var id = CacheElement(window);
            var rect = window.BoundingRectangle;
            return new
            {
                id,
                title = window.Name ?? "",
                processId = window.Properties.ProcessId.ValueOrDefault,
                nativeHandle = FormatHwnd(new IntPtr(window.Properties.NativeWindowHandle.ValueOrDefault)),
                bounds = new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height },
                isVisible = !window.Properties.IsOffscreen.ValueOrDefault
            };
        }

        private static object CacheAndSerializeElement(AutomationElement element)
        {
            var id = CacheElement(element);
            var rect = element.BoundingRectangle;
            return new
            {
                id,
                name = element.Name ?? "",
                controlType = element.ControlType.ToString(),
                isEnabled = element.IsEnabled,
                isVisible = !element.Properties.IsOffscreen.ValueOrDefault,
                bounds = new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height },
                value = TryGetValue(element)
            };
        }

        private static string CacheElement(AutomationElement element)
        {
            var id = $"elem_{++_elementIdCounter}";
            _elementCache[id] = element;
            return id;
        }

        private static Point GetClickableCenter(AutomationElement element)
        {
            if (!element.IsEnabled)
                throw new Exception($"Element \"{element.Name}\" is disabled");
            if (element.Properties.IsOffscreen.ValueOrDefault)
                throw new Exception($"Element \"{element.Name}\" is offscreen");

            var rect = element.BoundingRectangle;
            if (rect.Width <= 0 || rect.Height <= 0)
                throw new Exception($"Element \"{element.Name}\" has invalid bounds: {rect}");

            return new Point(
                Convert.ToInt32(Math.Round(Convert.ToDouble(rect.X + rect.Width / 2))),
                Convert.ToInt32(Math.Round(Convert.ToDouble(rect.Y + rect.Height / 2))));
        }

        private static MouseButton ParseMouseButton(string? button)
        {
            return (button ?? "left").ToLowerInvariant() switch
            {
                "left" => MouseButton.Left,
                "right" => MouseButton.Right,
                "middle" => MouseButton.Middle,
                _ => throw new ArgumentException($"Unknown mouse button: {button}")
            };
        }

        private static int NormalizeClickCount(int clickCount)
        {
            if (clickCount <= 0) throw new ArgumentException($"Invalid clickCount: {clickCount}");
            return clickCount;
        }

        private static void ClickAt(Point point, MouseButton button, int clickCount)
        {
            Mouse.MoveTo(point);
            if (clickCount == 2)
            {
                Mouse.DoubleClick(point, button);
                return;
            }
            for (int i = 0; i < clickCount; i++)
            {
                Mouse.Click(point, button);
            }
        }

        private static void Click(MouseButton button, int clickCount)
        {
            if (clickCount == 2)
            {
                Mouse.DoubleClick(button);
                return;
            }
            for (int i = 0; i < clickCount; i++)
            {
                Mouse.Click(button);
            }
        }

        private static VirtualKeyShort ParseModifier(string key)
        {
            return key.ToLowerInvariant() switch
            {
                "ctrl" or "control" => VirtualKeyShort.CONTROL,
                "shift" => VirtualKeyShort.SHIFT,
                "alt" => VirtualKeyShort.LMENU,
                "meta" or "cmd" or "command" or "win" or "windows" => VirtualKeyShort.LWIN,
                _ => throw new ArgumentException($"Unknown modifier key: {key}")
            };
        }

        private static VirtualKeyShort ParseVirtualKey(string key)
        {
            var lower = key.ToLowerInvariant();
            switch (lower)
            {
                case "enter":
                case "return": return VirtualKeyShort.ENTER;
                case "escape":
                case "esc": return VirtualKeyShort.ESCAPE;
                case "tab": return VirtualKeyShort.TAB;
                case "space": return VirtualKeyShort.SPACE;
                case "backspace": return VirtualKeyShort.BACK;
                case "delete": return VirtualKeyShort.DELETE;
                case "up":
                case "arrowup": return VirtualKeyShort.UP;
                case "down":
                case "arrowdown": return VirtualKeyShort.DOWN;
                case "left":
                case "arrowleft": return VirtualKeyShort.LEFT;
                case "right":
                case "arrowright": return VirtualKeyShort.RIGHT;
                case "home": return VirtualKeyShort.HOME;
                case "end": return VirtualKeyShort.END;
                case "pageup": return VirtualKeyShort.PRIOR;
                case "pagedown": return VirtualKeyShort.NEXT;
                case "+": return VirtualKeyShort.OEM_PLUS;
                case "-": return VirtualKeyShort.OEM_MINUS;
                case ",": return VirtualKeyShort.OEM_COMMA;
                case ".": return VirtualKeyShort.OEM_PERIOD;
                case "/": return VirtualKeyShort.OEM_2;
                case "\\": return VirtualKeyShort.OEM_5;
                case "[": return VirtualKeyShort.OEM_4;
                case "]": return VirtualKeyShort.OEM_6;
                case "`": return VirtualKeyShort.OEM_3;
                case "'": return VirtualKeyShort.OEM_7;
            }

            if (key.Length == 1)
            {
                char c = char.ToUpperInvariant(key[0]);
                if (c >= 'A' && c <= 'Z')
                {
                    return Enum.Parse<VirtualKeyShort>($"KEY_{c}");
                }
                if (c >= '0' && c <= '9')
                {
                    return Enum.Parse<VirtualKeyShort>($"KEY_{c}");
                }
            }

            if (lower.StartsWith("f") && int.TryParse(lower[1..], out var functionKey) && functionKey >= 1 && functionKey <= 24)
            {
                return Enum.Parse<VirtualKeyShort>($"F{functionKey}");
            }

            throw new ArgumentException($"Unknown key: {key}");
        }

        private static string? TryGetValue(AutomationElement element)
        {
            try { return element.AsTextBox()?.Text; }
            catch { return null; }
        }

        private static object BuildTree(AutomationElement element, int maxDepth, int depth = 0)
        {
            var children = new List<object>();
            if (depth < maxDepth)
            {
                foreach (var child in element.FindAllChildren())
                {
                    children.Add(BuildTree(child, maxDepth, depth + 1));
                }
            }

            return new
            {
                element = CacheAndSerializeElement(element),
                children = children.ToArray()
            };
        }

        private static ControlType ParseControlType(string name)
        {
            return name.ToLowerInvariant() switch
            {
                "button" => ControlType.Button,
                "edit" or "textbox" => ControlType.Edit,
                "checkbox" or "check box" => ControlType.CheckBox,
                "combobox" or "combo box" => ControlType.ComboBox,
                "list" => ControlType.List,
                "listitem" or "list item" => ControlType.ListItem,
                "menu" => ControlType.Menu,
                "menuitem" or "menu item" => ControlType.MenuItem,
                "tab" => ControlType.Tab,
                "tabitem" or "tab item" => ControlType.TabItem,
                "tree" => ControlType.Tree,
                "treeitem" or "tree item" => ControlType.TreeItem,
                "window" => ControlType.Window,
                "text" => ControlType.Text,
                "hyperlink" or "link" => ControlType.Hyperlink,
                "image" => ControlType.Image,
                "progressbar" or "progress bar" => ControlType.ProgressBar,
                "radiobutton" or "radio button" => ControlType.RadioButton,
                "scrollbar" or "scroll bar" => ControlType.ScrollBar,
                "slider" => ControlType.Slider,
                "spinner" => ControlType.Spinner,
                "statusbar" or "status bar" => ControlType.StatusBar,
                "toolbar" or "tool bar" => ControlType.ToolBar,
                "tooltip" or "tool tip" => ControlType.ToolTip,
                "document" => ControlType.Document,
                "group" => ControlType.Group,
                "pane" => ControlType.Pane,
                _ => throw new ArgumentException($"Unknown control type: {name}")
            };
        }
    }
}
