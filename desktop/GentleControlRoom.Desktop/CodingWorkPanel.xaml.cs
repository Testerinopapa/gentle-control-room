using GentleControlRoom.Desktop.CodingWork;
using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;

namespace GentleControlRoom.Desktop;

public partial class CodingWorkPanel : System.Windows.Controls.UserControl
{
    private readonly string _activityRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GentleControlRoom");
    private WorkStore _store = null!;
    private WindowsAnalysisSecret _secret = null!;
    private AnalysisCoordinator _analyzer = null!;
    private WorkState _state = new();
    private List<EvidenceRow> _rows = new();
    private AnalysisPreview? _preview;
    private Queue<string> _queue = new();
    private CancellationTokenSource? _cancel;
    private bool _ready, _busy, _rendering;
    private int _page;
    public CodingWorkPanel() { InitializeComponent(); }
    private string? TaskId => (TaskChoice.SelectedItem as CodingTask)?.Id;
    private static string Choice(System.Windows.Controls.ComboBox box) => (box.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "";
    private void Panel_Loaded(object sender, RoutedEventArgs e)
    {
        if (_ready) { _codeTimer.Start(); return; }
        var root = Path.Combine(_activityRoot, "CodingWork");
        _store = new(root); _secret = new(root);
        // Never follow redirects carrying Authorization to a different host.
        _analyzer = new(_store, new DeepSeekProvider(new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan }, _secret));
        _ready = true;
        Unloaded += (_, _) => { _cancel?.Cancel(); _analyzer.Discard(); };
        Safe(() => { Render(); LoadSettings(); InitializeCodeTracking(); });
    }
    private void Safe(Action action)
    {
        try { action(); }
        catch (AnalysisFailure ex) { WorkStatus.Text = ex.Message; }
        catch (InvalidOperationException) { WorkStatus.Text = "This action could not be completed. Check the selected task, input lengths, settings and local storage."; }
        catch (Exception) { WorkStatus.Text = "Local analysis is unavailable. No private contents were logged."; }
    }
    private async Task Run(Func<Task> action)
    {
        if (_busy) return; _busy = true; SendButton.IsEnabled = false;
        try { await action(); }
        catch (AnalysisFailure ex) { WorkStatus.Text = ex.Message; }
        catch (OperationCanceledException) { WorkStatus.Text = "Analysis cancelled."; }
        catch (Exception) { WorkStatus.Text = "The action could not be completed. Your local evidence is retained; no private contents were logged."; }
        finally { _busy = false; SendButton.IsEnabled = true; }
    }
    private void GuardLocal() { if (!_store.Read().LocalEnabled) throw new AnalysisFailure("Enable local task analysis in Analysis settings first."); }
    private void LoadSettings()
    {
        var s = _state.Settings; LocalConsent.IsChecked = _state.LocalEnabled; ExternalConsent.IsChecked = s.ExternalEnabled;
        ModelChoice.SelectedIndex = s.Model == "deepseek-v4-pro" ? 1 : 0;
        TokenLimit.Text = s.OutputTokens.ToString(); RequestLimit.Text = s.DailyRequests.ToString(); BudgetLimit.Text = s.DailyTokenBudget.ToString();
        TimeoutLimit.Text = s.TimeoutSeconds.ToString(); RetryLimit.Text = s.Retries.ToString();
    }
    private void SaveSettings_Click(object sender, RoutedEventArgs e) => Safe(() => {
        var settings = new AnalysisSettings { ExternalEnabled = ExternalConsent.IsChecked == true,
            Model = Choice(ModelChoice), OutputTokens = int.Parse(TokenLimit.Text), DailyRequests = int.Parse(RequestLimit.Text),
            DailyTokenBudget = int.Parse(BudgetLimit.Text), TimeoutSeconds = int.Parse(TimeoutLimit.Text), Retries = int.Parse(RetryLimit.Text) };
        settings.Validate();
        if (!string.IsNullOrEmpty(ApiKey.Password)) { _secret.Save(ApiKey.Password); ApiKey.Clear(); }
        _store.Update(s => {
            if (s.LocalEnabled && LocalConsent.IsChecked != true)
                foreach (var repo in s.Repositories.Where(r => r.Approved)) repo.ReceiptKey = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
            s.LocalEnabled = LocalConsent.IsChecked == true; s.Settings = settings; return true;
        });
        _cancel?.Cancel(); CancelPreview(); Render(); WorkStatus.Text = "Settings saved. No data was sent.";
    });
    private void RemoveKey_Click(object sender, RoutedEventArgs e) => Safe(() => { _cancel?.Cancel(); _secret.Delete(); ApiKey.Clear(); CancelPreview(); WorkStatus.Text = "Saved API key removed."; });
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await Run(async () => {
        GuardLocal(); var added = await Task.Run(() => _store.Update(s => { var n = EvidenceImporter.Refresh(s, _activityRoot, DateTimeOffset.UtcNow); s.Patterns = TaskService.FindPatterns(s); return n; }));
        CancelPreview(); Render(); WorkStatus.Text = $"Added {added} local observations. No external request was made.";
    });
    private void Create_Click(object sender, RoutedEventArgs e) => Safe(() => {
        GuardLocal(); var id = _store.Update(s => TaskService.Create(s, Objective.Text, Repository.Text).Id); CancelPreview(); Render(id);
    });
    private void Update_Click(object sender, RoutedEventArgs e) => Safe(() => {
        GuardLocal(); if (TaskId is not { } id) return;
        _store.Update(s => { TaskService.Edit(s, id, Objective.Text, Repository.Text, Choice(TaskStatus)); s.Patterns = TaskService.FindPatterns(s); return true; }); CancelPreview(); Render(id);
    });
    private void AddContext_Click(object sender, RoutedEventArgs e) => Safe(() => {
        GuardLocal(); if (TaskId is not { } id) return;
        _store.Update(s => TaskService.AddContext(s, id, ContextText.Text, Choice(ContextCategory))); ContextText.Clear(); CancelPreview(); Render(id);
        WorkStatus.Text = "Minimized context saved locally as unverified testimony. Review it in the task timeline.";
    });
    private async void ImportGit_Click(object sender, RoutedEventArgs e) => await Run(async () => {
        GuardLocal();
        using var dialog = new System.Windows.Forms.FolderBrowserDialog { Description = "Explicitly approve reading commit dates, hashes and file counts from this repository" };
        if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
        var records = await GitEvidence.ReadAsync(dialog.SelectedPath);
        _store.Update(s => { foreach (var record in records) if (!s.Evidence.Any(x => x.Id == record.Id)) s.Evidence.Add(record); return true; });
        Render(); WorkStatus.Text = "Commit evidence imported locally. Select relevant commits under evidence associations; none were assigned automatically.";
    });
    private void Assign_Click(object sender, RoutedEventArgs e) => Safe(() => {
        GuardLocal(); if (TaskId is not { } id) return;
        _store.Update(s => { TaskService.Associate(s, _rows.Where(r => r.Selected).Select(r => r.Id), id); return true; }); CancelPreview(); Render(id);
    });
    private void Detach_Click(object sender, RoutedEventArgs e) => Safe(() => {
        GuardLocal(); _store.Update(s => { TaskService.Associate(s, _rows.Where(r => r.Selected).Select(r => r.Id), null); return true; }); CancelPreview(); Render();
    });
    private void Task_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready || _rendering) return;
        FillEditor(); _page = 0; RenderEvidence();
    }
    private void FillEditor()
    {
        if (TaskChoice.SelectedItem is not CodingTask t) return;
        Objective.Text = t.Objective; Repository.Text = t.Repository;
        TaskStatus.SelectedIndex = Array.IndexOf(new[] { "Active", "Completed", "Unresolved", "Abandoned" }, t.Status);
    }
    private void EvidenceFilter_Changed(object sender, SelectionChangedEventArgs e) { if (_ready) { _page = 0; RenderEvidence(); } }
    private void Previous_Click(object sender, RoutedEventArgs e) { _page = Math.Max(0, _page - 1); RenderEvidence(); }
    private void Next_Click(object sender, RoutedEventArgs e) { _page++; RenderEvidence(); }
    private void Render(string? selected = null, WorkState? loaded = null)
    {
        selected ??= TaskId; _state = loaded ?? _store.Read(); _state.Patterns = TaskService.FindPatterns(_state); _rendering = true;
        TaskChoice.ItemsSource = _state.Tasks;
        TaskChoice.SelectedItem = _state.Tasks.FirstOrDefault(t => t.Id == selected) ?? _state.Tasks.FirstOrDefault();
        _rendering = false; FillEditor(); RenderEvidence();
        WorkSummary.Text = $"{_state.Tasks.Count(t => t.Status == "Active")} active · {_state.Tasks.Count(t => t.Status == "Completed")} declared completed · {_state.Evidence.Count} local observations · {_state.Tasks.Count(t => TaskService.IsCurrent(_state, t))} current analyses";
        TaskHistory.ItemsSource = _state.Tasks.OrderByDescending(t => t.CreatedAt).Select(t => {
            var timeline = TaskService.Timeline(_state, t.Id);
            _state.Analyses.TryGetValue(t.Id, out var a);
            var sessions = timeline.Where(x => x.SessionKey != "").Select(x => x.SessionKey).Distinct().ToArray();
            var analysis = a is null ? "Not analyzed. Objectives, outcomes and errors cannot be recovered from metadata alone." :
                $"DeepSeek · {a.Model} · {a.At.ToLocalTime():g} · {(TaskService.IsCurrent(_state, t) ? "Current" : "Outdated — evidence or settings changed")}\n" +
                $"Analyzed {a.Package.Timeline.Length} observations. Assessment: {a.Result.Status}\n" +
                string.Join("\n\n", a.Result.Claims.Select(c => $"{c.Section} · {c.Basis} · {c.Confidence:P0}\n{c.Text}\nEvidence: {string.Join(", ", c.EvidenceIds)}"));
            var supporting = a is null ? "" : "\n\nAnalysis evidence snapshot\n" + string.Join("\n", a.Package.Timeline.Select(x => $"{x.Id} · {x.At:g} · {x.Source} · {x.Session} · {x.Summary} [{x.Basis}]"));
            return new { Title = t.Objective, Summary = $"{t.Repository} · {t.Status} (user declared) · {sessions.Length} sessions · {timeline.Length} observations",
                Analysis = analysis, Timeline = string.Join("\n\n", timeline.Select(x => x.Display)) + supporting };
        }).ToArray();
        RenderCodeChanges();
        WorkPatterns.ItemsSource = _state.Patterns.Count == 0 ? new[] { "No supported recurring pattern yet. Multiple tasks or repeated attempts within a task are required." } :
            _state.Patterns.Select(p => $"{p.Title} · {p.Basis} · {p.Confidence:P0}\nFrequency: {p.Frequency}; tasks: {string.Join(", ", _state.Tasks.Where(t => p.TaskIds.Contains(t.Id)).Select(t => t.Objective))}\n{p.Recommendation}\n" +
                "Evidence: " + string.Join("; ", p.EvidenceIds.Take(12).Select(id => TaskService.PatternEvidence(_state, id))) + (p.EvidenceIds.Length > 12 ? " (first 12 shown; full timelines above)" : "")).ToArray();
    }
    private void RenderEvidence()
    {
        var evidence = _state.Evidence.Where(x => EvidenceFilter.SelectedIndex switch {
            0 => !_state.Associations.ContainsKey(x.Id), 1 => _state.Associations.GetValueOrDefault(x.Id) == TaskId, _ => true
        }).OrderByDescending(x => x.At).ToArray();
        _page = Math.Clamp(_page, 0, Math.Max(0, (evidence.Length - 1) / 30));
        var sessions = _state.Evidence.Where(e => e.SessionKey != "").OrderBy(e => e.At).Select(e => e.SessionKey).Distinct().ToArray();
        _rows = evidence.Skip(_page * 30).Take(30).Select(x => new EvidenceRow {
            Id = x.Id, Display = (x.SessionKey == "" ? "" : $"Session {Array.IndexOf(sessions, x.SessionKey) + 1} · ") + x.Display,
            Association = _state.Associations.TryGetValue(x.Id, out var id) ? "Assigned: " + _state.Tasks.Single(t => t.Id == id).Objective :
                "Suggested (confirm manually): " + string.Join(", ", TaskService.Suggest(_state, x).Select(t => _state.Tasks.Single(a => a.Id == t).Objective))
        }).ToList();
        EvidenceList.ItemsSource = _rows; EvidenceCount.Text = $"{evidence.Length} observations · page {_page + 1}. Selection applies to this page.";
    }
    private void Analyze_Click(object sender, RoutedEventArgs e) => Safe(() => {
        GuardLocal(); _queue.Clear(); if (TaskId is not { } id) return;
        var selected = _rows.Where(r => r.Selected && _state.Associations.GetValueOrDefault(r.Id) == id).Select(r => r.Id).ToArray();
        ShowPreview(id, selected.Length == 0 ? null : selected);
    });
    private void AnalyzeAll_Click(object sender, RoutedEventArgs e) => Safe(() => {
        GuardLocal(); _state = _store.Read(); _queue = new(_state.Tasks.Where(t => !TaskService.IsCurrent(_state, t)).Select(t => t.Id)); NextPreview();
    });
    private void NextPreview() { if (_queue.TryDequeue(out var id)) ShowPreview(id); else WorkStatus.Text = "No queued tasks remain. Nothing is analyzed automatically."; }
    private void ShowPreview(string id, string[]? selected = null)
    {
        _preview = _analyzer.Prepare(id, selected); PayloadText.Text = _preview.Payload; PayloadApproval.IsChecked = false;
        PayloadArea.Visibility = Visibility.Visible; WorkStatus.Text = "Payload prepared locally. Review and approve before any paid request.";
    }
    private async void Send_Click(object sender, RoutedEventArgs e) => await Run(async () => {
        if (_preview is null) return;
        _cancel = new();
        var result = await _analyzer.ApproveAndAnalyzeAsync(_preview, PayloadApproval.IsChecked == true, _cancel.Token);
        _preview = null; PayloadArea.Visibility = Visibility.Collapsed; PayloadText.Text = ""; Render(result.TaskId);
        WorkStatus.Text = "Task analysis saved locally. Review evidence and uncertainty in its history."; NextPreview();
    });
    private void CancelPreview() { _preview = null; _analyzer.Discard(); PayloadArea.Visibility = Visibility.Collapsed; PayloadApproval.IsChecked = false; PayloadText.Text = ""; _queue.Clear(); }
    private void Cancel_Click(object sender, RoutedEventArgs e) { _cancel?.Cancel(); CancelPreview(); WorkStatus.Text = "Cancelled. A request already sent may still be billed; no further requests will be sent."; }
    private sealed class EvidenceRow { public string Id { get; set; } = ""; public string Display { get; set; } = ""; public string Association { get; set; } = ""; public bool Selected { get; set; } }
}
