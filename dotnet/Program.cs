using System;
using System.Text.Json;
using FlaUIBridge;

var automation = new Automation();

// Read one JSON command per line from stdin, write JSON result to stdout.
// Protocol: { "method": "...", "params": { ... } }
// Response: { "result": ... } or { "error": "..." }
string? line;
while ((line = Console.ReadLine()) != null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;

    try
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
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
                new { elementId = p.GetProperty("elementId").GetString()! }),

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

            "listWindows" => await automation.ListWindows(null!),

            "getElementTree" => await automation.GetElementTree(
                new { windowId = p.GetProperty("windowId").GetString()! }),

            _ => throw new Exception($"Unknown method: {method}")
        };

        Console.WriteLine(JsonSerializer.Serialize(new { result }));
    }
    catch (Exception ex)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { error = ex.Message }));
    }

    Console.Out.Flush();
}
