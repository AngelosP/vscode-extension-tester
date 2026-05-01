using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
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
        private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

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
            var desktop = _automation.GetDesktop();
            var windows = desktop.FindAllChildren(
                cf => cf.ByControlType(ControlType.Window));

            return windows
                .Where(w => !string.IsNullOrEmpty(w.Name) && w.Properties.IsOffscreen.ValueOrDefault == false)
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

            if (!_elementCache.TryGetValue(windowId, out var element))
                throw new Exception($"Window {windowId} not found in cache");

            var attempts = new List<object>();
            var warnings = new List<string>();
            Exception? lastError = null;

            for (int attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    var capture = await PrepareCapture(element);
                    SaveCopyFromScreen(capture.X, capture.Y, capture.Width, capture.Height, filePath);
                    attempts.Add(new { attempt, strategy = "CopyFromScreen", success = true });
                    return BuildScreenshotResult(filePath, capture, "CopyFromScreen", attempts, warnings);
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
                    var capture = await PrepareCapture(element);
                    SavePrintWindow(new IntPtr(nativeHandle), capture.Width, capture.Height, filePath);
                    attempts.Add(new { attempt = 4, strategy = "PrintWindow", success = true });
                    warnings.Add("Used PrintWindow fallback after CopyFromScreen failures; Chromium content can render blank on some systems.");
                    return BuildScreenshotResult(filePath, capture, "PrintWindow", attempts, warnings);
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    attempts.Add(new { attempt = 4, strategy = "PrintWindow", success = false, message = ex.Message });
                }
            }

            throw new Exception($"Screenshot capture failed after retries: {lastError?.Message}", lastError);
        }

        private static async Task<CaptureSnapshot> PrepareCapture(AutomationElement element)
        {
            var window = element.AsWindow();
            var nativeHandle = element.Properties.NativeWindowHandle.ValueOrDefault;
            if (nativeHandle != 0) ShowWindow(new IntPtr(nativeHandle), SW_RESTORE);
            window.SetForeground();
            await Task.Delay(200);

            if (element.Properties.IsOffscreen.ValueOrDefault)
                throw new Exception("Window is minimized or offscreen after restore; cannot capture screenshot");

            var rect = element.BoundingRectangle;
            int x = Convert.ToInt32(Math.Round(Convert.ToDouble(rect.X)));
            int y = Convert.ToInt32(Math.Round(Convert.ToDouble(rect.Y)));
            int width = Convert.ToInt32(Math.Round(Convert.ToDouble(rect.Width)));
            int height = Convert.ToInt32(Math.Round(Convert.ToDouble(rect.Height)));
            if (width <= 0 || height <= 0)
                throw new Exception($"Window has invalid screenshot bounds: {rect}");
            return new CaptureSnapshot(
                x,
                y,
                width,
                height,
                element.Name ?? "",
                element.Properties.ProcessId.ValueOrDefault
            );
        }

        private static object BuildScreenshotResult(
            string filePath,
            CaptureSnapshot capture,
            string strategy,
            List<object> attempts,
            List<string> warnings)
        {
            return new
            {
                success = true,
                filePath,
                width = capture.Width,
                height = capture.Height,
                strategy,
                captureMethod = strategy,
                windowProcessId = capture.ProcessId,
                windowTitle = capture.Title,
                windowBounds = new { x = capture.X, y = capture.Y, width = capture.Width, height = capture.Height },
                attempts = attempts.ToArray(),
                warnings = warnings.ToArray()
            };
        }

        private sealed record CaptureSnapshot(
            int X,
            int Y,
            int Width,
            int Height,
            string Title,
            int ProcessId
        );

        private static void SaveCopyFromScreen(int x, int y, int width, int height, string filePath)
        {
            using var bitmap = new Bitmap(width, height);
            using var graphics = Graphics.FromImage(bitmap);
            graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height));
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
            SavePngAtomically(bitmap, filePath);
        }

        private static void SavePngAtomically(Bitmap bitmap, string filePath)
        {
            var directory = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var tempPath = filePath + ".tmp";
            bitmap.Save(tempPath, ImageFormat.Png);
            if (new FileInfo(tempPath).Length == 0)
                throw new Exception("Screenshot file was empty after save");
            if (File.Exists(filePath)) File.Delete(filePath);
            File.Move(tempPath, filePath);
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
