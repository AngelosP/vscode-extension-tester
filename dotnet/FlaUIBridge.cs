using System;
using System.Collections.Generic;
using System.Linq;
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
        private static readonly UIA3Automation _automation = new();
        private static readonly Dictionary<string, AutomationElement> _elementCache = new();
        private static int _elementIdCounter = 0;

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

            element.Click();
            return new { success = true };
        }

        /// <summary>
        /// Press a keyboard key (e.g. Enter, Escape, Tab).
        /// Input: { key: string }
        /// </summary>
        public async Task<object> PressKey(dynamic input)
        {
            string key = (string)input.key;
            var vk = key.ToLowerInvariant() switch
            {
                "enter" or "return" => VirtualKeyShort.ENTER,
                "escape" or "esc" => VirtualKeyShort.ESCAPE,
                "tab" => VirtualKeyShort.TAB,
                "space" => VirtualKeyShort.SPACE,
                "backspace" => VirtualKeyShort.BACK,
                "delete" => VirtualKeyShort.DELETE,
                "up" => VirtualKeyShort.UP,
                "down" => VirtualKeyShort.DOWN,
                "left" => VirtualKeyShort.LEFT,
                "right" => VirtualKeyShort.RIGHT,
                "home" => VirtualKeyShort.HOME,
                "end" => VirtualKeyShort.END,
                _ => throw new ArgumentException($"Unknown key: {key}")
            };
            Keyboard.Press(vk);
            await Task.Delay(50); // brief settle time
            Keyboard.Release(vk);
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
