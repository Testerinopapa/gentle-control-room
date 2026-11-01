using System;
using System.Text.Json;
using System.Windows;

namespace GentleControlRoom.Desktop;

public partial class MainWindow
{
  private void ApplyPreferredWindowSize(double? contentWidth, double? contentHeight)
  {
    // Width is controlled by the user and shared max-width, never by a measurement
    // of the constrained browser viewport (which would cause a shrink feedback loop).
    if (contentHeight is not > 0 || !double.IsFinite(contentHeight.Value)) return;
    AppWebView.Height = Math.Clamp(contentHeight.Value + 16, 120, 10000);
    FitWorkspaceHeight();
  }

  private void FitWorkspaceHeight()
  {
    if (WindowState != WindowState.Normal) return;
    var frameHeight = Math.Max(0, ActualHeight - WorkspaceRoot.ActualHeight);
    var workArea = SystemParameters.WorkArea;
    var desired = AppWebView.Height + CodingWorkCard.ActualHeight + ActivityCard.ActualHeight + BrowserActivityCard.ActualHeight + 16 + frameHeight;
    Height = Math.Clamp(desired, Math.Min(MinHeight, workArea.Height), workArea.Height);
    if (Top + Height > workArea.Bottom) Top = Math.Max(workArea.Top, workArea.Bottom - Height);
  }

  private void ResetPreferredWindowSize()
  {
    // Older hosted pages only report size after login. Keep their full login form
    // scrollable until a measured content height is available.
    AppWebView.Height = 600;
    FitWorkspaceHeight();
  }

  private static bool TryReadDouble(JsonElement element, string propertyName, out double value)
  {
    value = 0;
    return element.ValueKind == JsonValueKind.Object
      && element.TryGetProperty(propertyName, out var property)
      && property.ValueKind == JsonValueKind.Number
      && property.TryGetDouble(out value) && double.IsFinite(value);
  }
}
