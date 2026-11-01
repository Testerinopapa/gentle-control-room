using CommunityToolkit.WinUI.Notifications;
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using NotifyIcon = System.Windows.Forms.NotifyIcon;

namespace GentleControlRoom.Desktop;

public partial class MainWindow : System.Windows.Window
{
  private const string ToastLaunchArgument = "action=open-app";
  private readonly DesktopHostConfig _config;
  private readonly bool _startInBackground;
  private readonly NotifyIcon _notifyIcon;
  private readonly string _diagnosticLogPath;
  private readonly DispatcherTimer _codexTimer = new() { Interval = TimeSpan.FromSeconds(20) };
  private bool _codexRefreshInFlight;
  private CodexPeriod _codexPeriod;
  private bool _initialized;
  private bool _exitRequested;

  private bool ShouldUseTrayBehavior =>
    _startInBackground || _config.Behavior.StartInTray;

  private bool ShouldMinimizeToTray =>
    ShouldUseTrayBehavior || _config.Behavior.MinimizeToTray;

  private bool ShouldCloseToTray =>
    ShouldUseTrayBehavior || _config.Behavior.CloseToTray;

  public MainWindow(bool startInBackground)
  {
    InitializeComponent();

    _startInBackground = startInBackground;
    _config = DesktopHostConfig.Load(AppContext.BaseDirectory);
    _diagnosticLogPath = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
      "GentleControlRoom",
      "logs",
      "desktop-host.log");
    _notifyIcon = CreateNotifyIcon();
    RegisterToastActivationHandler();
    ActivityCard.SizeChanged += (_, _) => FitWorkspaceHeight();
    BrowserActivityCard.SizeChanged += (_, _) => FitWorkspaceHeight();
    _codexTimer.Tick += (_, _) => RefreshCodexActivity();
    LogDiagnostic("Desktop host initialized.");
  }

  private async void Window_Loaded(object sender, System.Windows.RoutedEventArgs e)
  {
    RefreshCodexActivity();
    _codexTimer.Start();
    try
    {
      await InitializeWebViewAsync();
      _initialized = true;
      LoadingOverlay.Visibility = System.Windows.Visibility.Collapsed;
      LogDiagnostic("WebView initialized successfully.");

      if (ShouldUseTrayBehavior)
      {
        HideToTray(showBalloonTip: false);
      }
    }
    catch (Exception ex)
    {
      LogDiagnostic($"Startup failed: {ex}");
      StatusText.Text = ex.Message;
      System.Windows.MessageBox.Show(
        this,
        $"{ex.Message}\n\nInstall the WebView2 Runtime and verify appsettings.json before retrying.",
        "Desktop host startup failed",
        System.Windows.MessageBoxButton.OK,
        System.Windows.MessageBoxImage.Error);

      ExitApplication();
    }
  }

  private async Task InitializeWebViewAsync()
  {
    StatusText.Text = "Checking Microsoft Edge WebView2 Runtime...";

    if (string.IsNullOrWhiteSpace(CoreWebView2Environment.GetAvailableBrowserVersionString()))
    {
      throw new InvalidOperationException("Microsoft Edge WebView2 Runtime is not installed.");
    }

    var userDataFolder = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
      "GentleControlRoom",
      "WebView2");

    Directory.CreateDirectory(userDataFolder);

    var environment = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, userDataFolder);
    await AppWebView.EnsureCoreWebView2Async(environment);

    AppWebView.CoreWebView2.Settings.AreDevToolsEnabled = _config.Behavior.EnableDevTools;
    AppWebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = _config.Behavior.EnableDevTools;
    AppWebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
    AppWebView.CoreWebView2.Settings.IsZoomControlEnabled = false;
    AppWebView.CoreWebView2.WebMessageReceived += HandleWebMessageReceived;
    AppWebView.CoreWebView2.NewWindowRequested += (_, args) =>
    {
      args.Handled = true;
      if (!string.IsNullOrWhiteSpace(args.Uri))
      {
        AppWebView.CoreWebView2.Navigate(args.Uri);
      }
    };

    var scriptConfig = JsonSerializer.Serialize(
      _config.ToScriptConfig(),
      new JsonSerializerOptions
      {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
      });

    await AppWebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
      $"window.__desktopConfig = Object.freeze({scriptConfig});");

    StatusText.Text = "Loading desktop experience...";

    var hostedUrl = _config.WebUi.HostedUrl?.Trim();
    if (!string.IsNullOrWhiteSpace(hostedUrl))
    {
      if (!Uri.TryCreate(hostedUrl, UriKind.Absolute, out var hostedUri))
      {
        throw new InvalidOperationException($"Hosted desktop URL is invalid: {hostedUrl}");
      }

      AppWebView.Source = hostedUri;
      return;
    }

    var webRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
    if (!Directory.Exists(webRoot))
    {
      throw new DirectoryNotFoundException($"Desktop web UI assets were not found: {webRoot}");
    }

    AppWebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
      _config.WebUi.VirtualHostName,
      webRoot,
      CoreWebView2HostResourceAccessKind.Allow);

    AppWebView.Source = new Uri($"https://{_config.WebUi.VirtualHostName}/{_config.WebUi.StartPage.TrimStart('/')}");
  }

  private NotifyIcon CreateNotifyIcon()
  {
    var menu = new System.Windows.Forms.ContextMenuStrip();
    menu.Items.Add("Open", null, (_, _) => Dispatcher.Invoke(ShowFromTray));
    menu.Items.Add("Exit", null, (_, _) => Dispatcher.Invoke(ExitApplication));

    System.Drawing.Icon? appIcon = null;
    try
    {
      var processPath = Process.GetCurrentProcess().MainModule?.FileName;
      if (!string.IsNullOrWhiteSpace(processPath))
      {
        appIcon = System.Drawing.Icon.ExtractAssociatedIcon(processPath);
      }
    }
    catch
    {
      // Fall back to the system shield icon if the packaged app icon can't be loaded.
    }

    var icon = new NotifyIcon
    {
      Text = "Gentle Control Room",
      Visible = true,
      Icon = appIcon ?? SystemIcons.Shield,
      ContextMenuStrip = menu,
    };

    icon.DoubleClick += (_, _) => Dispatcher.Invoke(ShowFromTray);
    icon.BalloonTipClicked += (_, _) => Dispatcher.Invoke(ShowFromTray);
    return icon;
  }

  private void HandleWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
  {
    try
    {
      // Raw WebView payloads can contain access/refresh tokens; never log them.
      using var document = JsonDocument.Parse(args.WebMessageAsJson);
      var root = document.RootElement;

      if (!root.TryGetProperty("type", out var typeElement))
      {
        return;
      }

      var messageType = typeElement.GetString();
      if (string.Equals(messageType, "desktop.window.setPreferredSize", StringComparison.Ordinal))
      {
        if (!root.TryGetProperty("payload", out var sizePayload))
        {
          return;
        }

        double? contentWidth = TryReadDouble(sizePayload, "contentWidth", out var nextWidth) ? nextWidth : null;
        double? contentHeight = TryReadDouble(sizePayload, "contentHeight", out var nextHeight) ? nextHeight : null;

        Dispatcher.Invoke(() => ApplyPreferredWindowSize(contentWidth, contentHeight));
        return;
      }

      if (string.Equals(messageType, "desktop.window.resetSize", StringComparison.Ordinal))
      {
        Dispatcher.Invoke(ResetPreferredWindowSize);
        return;
      }

      if (string.Equals(messageType, "desktop.window.hideToTray", StringComparison.Ordinal))
      {
        Dispatcher.Invoke(() => HideToTray(showBalloonTip: false));
        return;
      }

      if (string.Equals(messageType, "desktop.window.show", StringComparison.Ordinal))
      {
        Dispatcher.Invoke(ShowFromTray);
        return;
      }

      if (!string.Equals(messageType, "desktop.alert.received", StringComparison.Ordinal))
      {
        return;
      }

      if (!root.TryGetProperty("payload", out var payloadElement))
      {
        return;
      }

      var title = payloadElement.TryGetProperty("title", out var titleElement)
        ? titleElement.GetString()
        : null;

      var message = payloadElement.TryGetProperty("message", out var messageElement)
        ? messageElement.GetString()
        : null;

      ShowAlertNotification(title, message);
    }
    catch (Exception)
    {
      // Avoid echoing private message payloads or parser details into disk logs.
      LogDiagnostic("Ignored invalid WebView message.");
    }
  }

  // Local-only native WPF panel. No Codex data is sent into WebView2.
  private async void RefreshCodexActivity()
  {
    if (_codexRefreshInFlight || _exitRequested)
    {
      return;
    }

    _codexRefreshInFlight = true;
    var period = _codexPeriod;
    try
    {
      // Reading up to 50 MiB of local JSONL must not freeze the alert UI.
      var result = await Task.Run(() => (
        Codex: CodexActivityReader.Read(period),
        Browser: BrowserActivityReader.Read(period)));
      if (_exitRequested || period != _codexPeriod)
      {
        return;
      }

      var snapshot = result.Codex;
      var browser = result.Browser;
      var periodLabel = period switch
      {
        CodexPeriod.Today => "today",
        CodexPeriod.LastSevenDays => "in the last 7 days",
        _ => "in available history"
      };
      BrowserSummaryText.Text =
        $"Opted-in ChatGPT sessions {periodLabel}: {browser.SessionsToday}. " +
        $"Coding-related sessions: {browser.CodingSessions}; " +
        $"visible code examples: {browser.CodeBlocks}. " +
        $"Visible messages (approx.): {browser.VisibleUser} yours, " +
        $"{browser.VisibleAssistant} ChatGPT. Events: {browser.EventsToday}.";
      BrowserLatestText.Text = browser.Latest + " · local only";
      CodexStatusText.Text = $"Collector: {snapshot.State} | Approved projects now: {snapshot.Projects}";
      CodexSummaryText.Text = snapshot.Summary;
      CodexHistory.ItemsSource = snapshot.History;
      // Keep sources distinct. ChatGPT code examples or explicit coding tags do
      // not prove that files were modified; only Codex hook events imply tool use.
      var patterns = snapshot.Patterns
        .Where(p => !p.StartsWith("No recurring sequence", StringComparison.Ordinal))
        .ToList();
      patterns.AddRange(browser.Patterns);
      if (patterns.Count == 0)
      {
        patterns.Add("No recurring coding pattern yet. At least three separate sessions with a matching signal are needed.");
      }
      CodexPatterns.ItemsSource = patterns;
      CodexHistoryEmpty.Visibility = snapshot.History.Count == 0
        ? System.Windows.Visibility.Visible : System.Windows.Visibility.Collapsed;
      CodexOverview.ItemsSource = new[]
      {
        new { Label = "Sessions", Value = snapshot.Sessions },
        new { Label = "Tool operations", Value = snapshot.ToolUses },
        new { Label = "Recorded events", Value = snapshot.Events }
      };
      CodexCategories.ItemsSource = snapshot.Categories;
      CodexRecent.ItemsSource = snapshot.Recent;
      CodexEmptyText.Visibility = snapshot.Recent.Count == 0
        ? System.Windows.Visibility.Visible : System.Windows.Visibility.Collapsed;
      CodexUpdatedText.Text = $"Updated {DateTime.Now:HH:mm:ss} - every 20 seconds";
    }
    catch (Exception)
    {
      // Fail closed without logging local paths, consent values or event data.
      CodexStatusText.Text = "Unavailable";
      BrowserSummaryText.Text = "Browser activity could not be read.";
    }
    finally
    {
      _codexRefreshInFlight = false;
      if (!_exitRequested && period != _codexPeriod) RefreshCodexActivity();
    }
  }

  private void CodexPeriod_Changed(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
  {
    if (CodexPeriodFilter is null || CodexPeriodFilter.SelectedIndex < 0) return;
    _codexPeriod = (CodexPeriod)CodexPeriodFilter.SelectedIndex;
    if (!IsLoaded) return;
    // Clear the old period immediately; an in-flight read is discarded and retried.
    CodexSummaryText.Text = "Reading local activity...";
    BrowserSummaryText.Text = "Reading local ChatGPT activity...";
    CodexHistory.ItemsSource = null;
    CodexPatterns.ItemsSource = null;
    CodexOverview.ItemsSource = null;
    CodexCategories.ItemsSource = null;
    CodexRecent.ItemsSource = null;
    CodexHistoryEmpty.Visibility = System.Windows.Visibility.Collapsed;
    CodexEmptyText.Visibility = System.Windows.Visibility.Collapsed;
    RefreshCodexActivity();
  }

  private void CodexRefresh_Click(object sender, System.Windows.RoutedEventArgs e)
  {
    RefreshCodexActivity();
  }

  private void ShowAlertNotification(string? title, string? message)
  {
    if (!_config.Behavior.EnableNativeNotifications)
    {
      return;
    }

    var notificationTitle = string.IsNullOrWhiteSpace(title) ? "New alert" : title.Trim();
    var notificationBody = string.IsNullOrWhiteSpace(message)
      ? "A new alert is available in Gentle Control Room."
      : message.Trim();

    if (notificationTitle.Length > 63)
    {
      notificationTitle = notificationTitle[..60] + "...";
    }

    if (notificationBody.Length > 255)
    {
      notificationBody = notificationBody[..252] + "...";
    }

    try
    {
      LogDiagnostic("Showing toast notification.");
      new ToastContentBuilder()
        .AddArgument("launch", ToastLaunchArgument)
        .AddText(notificationTitle)
        .AddText(notificationBody)
        .Show();
      return;
    }
    catch (Exception ex)
    {
      LogDiagnostic($"Toast notification failed. Falling back to tray balloon. {ex}");
    }

    _notifyIcon.ShowBalloonTip(
      5000,
      notificationTitle,
      notificationBody,
      System.Windows.Forms.ToolTipIcon.Info);
  }

  private void Window_StateChanged(object? sender, EventArgs e)
  {
    if (_initialized && ShouldMinimizeToTray && WindowState == System.Windows.WindowState.Minimized)
    {
      HideToTray(showBalloonTip: false);
    }
  }

  private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
  {
    if (_exitRequested || !ShouldCloseToTray)
    {
      return;
    }

    e.Cancel = true;
    HideToTray(showBalloonTip: true);
  }

  private void HideToTray(bool showBalloonTip)
  {
    Hide();
    ShowInTaskbar = false;
    WindowState = System.Windows.WindowState.Minimized;

    if (showBalloonTip)
    {
      _notifyIcon.ShowBalloonTip(
        3000,
        "Gentle Control Room",
        "The app is still running in the notification area.",
        System.Windows.Forms.ToolTipIcon.Info);
    }
  }

  private void ShowFromTray()
  {
    Show();
    ShowInTaskbar = true;
    WindowState = System.Windows.WindowState.Normal;
    Activate();
  }

  private void ExitApplication()
  {
    _codexTimer.Stop();
    LogDiagnostic("Desktop host shutting down.");
    _exitRequested = true;
    _notifyIcon.Visible = false;
    _notifyIcon.Dispose();
    Close();
    System.Windows.Application.Current.Shutdown();
  }

  private void RegisterToastActivationHandler()
  {
    try
    {
      ToastNotificationManagerCompat.OnActivated += (_) =>
      {
        LogDiagnostic("Toast activated by user.");
        Dispatcher.Invoke(ShowFromTray);
      };
      LogDiagnostic("Toast activation handler registered.");
    }
    catch (Exception ex)
    {
      LogDiagnostic($"Failed to register toast activation handler: {ex}");
    }
  }

  private void LogDiagnostic(string message)
  {
    try
    {
      var logDirectory = Path.GetDirectoryName(_diagnosticLogPath);
      if (!string.IsNullOrWhiteSpace(logDirectory))
      {
        Directory.CreateDirectory(logDirectory);
      }

      File.AppendAllText(
        _diagnosticLogPath,
        $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff zzz}] {message}{Environment.NewLine}");
    }
    catch
    {
      // Avoid crashing because of diagnostics.
    }
  }
}
