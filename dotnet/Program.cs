using System;
using System.Text.Json;
using FlaUIBridge;

var automation = new Automation();

// Read one JSON command per line from stdin, write JSON result to stdout.
// Protocol: { "id": 1, "method": "...", "params": { ... } }
// Response: { "id": 1, "result": ... } or { "id": 1, "error": "..." }
string? line;
while ((line = Console.ReadLine()) != null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;

    int? id = null;

    try
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        if (root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number)
        {
            id = idEl.GetInt32();
        }
        var method = root.GetProperty("method").GetString()!;
        var p = root.TryGetProperty("params", out var paramsEl) ? paramsEl : default;

        object? result = method switch
        {
            "findWindow" => await automation.FindWindow(
                new { titlePattern = p.GetProperty("titlePattern").GetString()! }),

            "findElement" => await automation.FindElement(
                new
                {
                    windowId = p.GetProperty("windowId").GetString()!,
                    name = p.GetProperty("name").GetString()!,
                    controlType = p.TryGetProperty("controlType", out var ct) ? ct.GetString() : null
                }),

            "clickElement" => await automation.ClickElement(
                new
                {
                    elementId = p.GetProperty("elementId").GetString()!,
                    button = p.TryGetProperty("button", out var btn) ? btn.GetString() : null,
                    clickCount = p.TryGetProperty("clickCount", out var cc) ? cc.GetInt32() : 1
                }),

            "moveMouse" => await automation.MoveMouse(
                new
                {
                    x = p.GetProperty("x").GetDouble(),
                    y = p.GetProperty("y").GetDouble()
                }),

            "clickMouse" => await automation.ClickMouse(
                new
                {
                    x = p.TryGetProperty("x", out var mx) && mx.ValueKind != JsonValueKind.Null ? mx.GetDouble() : (double?)null,
                    y = p.TryGetProperty("y", out var my) && my.ValueKind != JsonValueKind.Null ? my.GetDouble() : (double?)null,
                    button = p.TryGetProperty("button", out var mouseBtn) ? mouseBtn.GetString() : null,
                    clickCount = p.TryGetProperty("clickCount", out var mouseCc) ? mouseCc.GetInt32() : 1
                }),

            "setText" => await automation.SetText(
                new
                {
                    elementId = p.GetProperty("elementId").GetString()!,
                    text = p.GetProperty("text").GetString()!
                }),

            "focusWindow" => await automation.FocusWindow(
                new { windowId = p.GetProperty("windowId").GetString()! }),

            "resizeWindow" => await automation.ResizeWindow(
                new
                {
                    windowId = p.GetProperty("windowId").GetString()!,
                    width = p.GetProperty("width").GetDouble(),
                    height = p.GetProperty("height").GetDouble()
                }),

            "moveWindow" => await automation.MoveWindow(
                new
                {
                    windowId = p.GetProperty("windowId").GetString()!,
                    x = p.GetProperty("x").GetDouble(),
                    y = p.GetProperty("y").GetDouble()
                }),

            "captureWindowScreenshot" => await automation.CaptureWindowScreenshot(
                new
                {
                    windowId = p.GetProperty("windowId").GetString()!,
                    filePath = p.GetProperty("filePath").GetString()!
                }),

            "listWindows" => await automation.ListWindows(null!),

            "getElementTree" => await automation.GetElementTree(
                new { windowId = p.GetProperty("windowId").GetString()! }),

            "pressKey" => await automation.PressKey(
                new { key = p.GetProperty("key").GetString()! }),

            "findPopupItems" => await automation.FindPopupItems(
                new { windowId = p.GetProperty("windowId").GetString()! }),

            "selectPopupItem" => await automation.SelectPopupItem(
                new
                {
                    windowId = p.GetProperty("windowId").GetString()!,
                    itemName = p.GetProperty("itemName").GetString()!
                }),

            _ => throw new Exception($"Unknown method: {method}")
        };

        Console.WriteLine(JsonSerializer.Serialize(new { id, result }));
    }
    catch (Exception ex)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { id, error = ex.Message }));
    }

    Console.Out.Flush();
}
