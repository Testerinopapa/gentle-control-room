using GentleControlRoom.Desktop.CodingWork;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace GentleControlRoom.Desktop;

public partial class CodingWorkPanel
{
    private readonly DispatcherTimer _codeTimer = new() { Interval = TimeSpan.FromSeconds(30) };
    private bool _codeRendering;
    private sealed record ChangeRow(string Id, string Display);
    private string? RepositoryId => (CodeRepositories.SelectedItem as TrackedRepository)?.Id;
    private string? ChangeId => (CodeChangeChoice.SelectedItem as ChangeRow)?.Id;
    private void InitializeCodeTracking()
    {
        _codeTimer.Tick += async (_, _) => await CheckChanges();
        Unloaded += (_, _) => _codeTimer.Stop();
        _codeTimer.Start();
    }
    private async Task CheckChanges() => await Run(async () => {
        var added = await Task.Run(async () => {
            var n = _store.Update(s => EvidenceImporter.Refresh(s, _activityRoot, DateTimeOffset.UtcNow));
            n += await CodeTracking.PollAsync(_store);
            n += await GitHubCommitImporter.ImportAsync(_store);
            n += _store.Update(s => VerificationReceipts.Import(s, Path.Combine(_activityRoot, "CodingWork", "CodeResults")));
            return n;
        });
        var latest = await Task.Run(_store.Read);
        if (added > 0) { CancelPreview(); Render(loaded: latest); WorkStatus.Text = $"Recorded {added} local activity/change observations. GitHub references may have been fetched; nothing was sent to DeepSeek."; }
        else { _state = latest; RenderCodeChanges(); }
    });
    private async void CheckChanges_Click(object sender, RoutedEventArgs e) => await CheckChanges();
    private async void ApproveRepository_Click(object sender, RoutedEventArgs e) => await Run(async () => {
        GuardLocal();
        using var dialog = new System.Windows.Forms.FolderBrowserDialog { Description = "Approve automatic local diff tracking in this Git repository. Existing changes form a baseline, not new observations." };
        if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
        var untracked = TrackUntracked.IsChecked == true;
        var exclusions = CodeExclusions.Text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var id = await Task.Run(() => CodeTracking.ApproveAsync(_store, dialog.SelectedPath, untracked, exclusions));
        CancelPreview(); Render(loaded: await Task.Run(_store.Read)); CodeRepositories.SelectedItem = _state.Repositories.Single(r => r.Id == id);
        WorkStatus.Text = "Repository approved and baseline recorded locally. Automatic checks run every 30 seconds while the app is running.";
    });
    private async void PauseTracking_Click(object sender, RoutedEventArgs e) => await Run(async () => {
        if (RepositoryId is not { } id) return;
        await Task.Run(() => _store.Update(s => { var r = s.Repositories.Single(r => r.Id == id); CodeTracking.Pause(s, id, !r.Paused); return true; }));
        CancelPreview(); Render(loaded: await Task.Run(_store.Read));
    });
    private async void RevokeTracking_Click(object sender, RoutedEventArgs e) => await Run(async () => {
        if (RepositoryId is not { } id) return;
        await Task.Run(() => _store.Update(s => { CodeTracking.Revoke(s, id); return true; }));
        _cancel?.Cancel(); CancelPreview(); Render(loaded: await Task.Run(_store.Read));
    });
    private async void DeleteChanges_Click(object sender, RoutedEventArgs e) => await Run(async () => {
        if (RepositoryId is not { } id) return;
        if (System.Windows.MessageBox.Show("Revoke this repository and delete its tracked history, result receipts, and stored analyses citing that evidence? Git files will not be changed.",
            "Delete local change history", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        await Task.Run(() => {
            _store.Update(s => { CodeTracking.DeleteHistory(s, id); return true; });
            VerificationReceipts.Delete(Path.Combine(_activityRoot, "CodingWork", "CodeResults"), id);
        });
        _cancel?.Cancel(); CancelPreview(); Render(loaded: await Task.Run(_store.Read)); CodeDiffText.Clear();
    });
    private void RenderCodeChanges()
    {
        var repo = RepositoryId; var change = ChangeId; _codeRendering = true;
        CodeRepositories.ItemsSource = _state.Repositories;
        CodeRepositories.SelectedItem = _state.Repositories.FirstOrDefault(r => r.Id == repo) ?? _state.Repositories.FirstOrDefault();
        var selected = CodeRepositories.SelectedItem as TrackedRepository;
        CodeRepositoryStatus.Text = selected is null ? "No approved repositories. Tracking is off." : selected.Root + "\n" + selected.Status;
        var rows = _state.CodeChanges.Where(c => c.RepositoryId == selected?.Id).OrderByDescending(c => c.At)
            .Select(c => new ChangeRow(c.Id, $"{c.At.ToLocalTime():MMM d HH:mm:ss} - {c.Current.Layer} - {c.Current.Path} (+{c.Current.Additions}/-{c.Current.Deletions})")).ToArray();
        CodeChangeChoice.ItemsSource = rows; CodeChangeChoice.SelectedItem = rows.FirstOrDefault(r => r.Id == change) ?? rows.FirstOrDefault();
        _codeRendering = false; ShowCodeChange();
    }
    private void CodeRepository_Changed(object sender, SelectionChangedEventArgs e) { if (_ready && !_codeRendering) Safe(RenderCodeChanges); }
    private void CodeChange_Changed(object sender, SelectionChangedEventArgs e) { if (_ready && !_codeRendering) Safe(ShowCodeChange); }
    private void ShowCodeChange()
    {
        var change = _state.CodeChanges.FirstOrDefault(c => c.Id == ChangeId);
        if (change is null) { CodeDiffText.Clear(); CodeRelatedText.Text = "No post-baseline changes recorded for this repository."; CodeOutcomeText.Text = "Verification: unknown."; return; }
        var evidence = _state.Evidence.Single(e => e.Id == change.Id);
        var taskId = _state.Associations.GetValueOrDefault(change.Id);
        var task = _state.Tasks.FirstOrDefault(t => t.Id == taskId);
        var related = task is null ? "Unassigned. Suggested tasks (confirm manually): " + string.Join(", ", TaskService.Suggest(_state, evidence).Select(id => _state.Tasks.Single(t => t.Id == id).Objective)) :
            "User-associated task: " + task.Objective + $". {TaskService.Timeline(_state, task.Id).Where(e => e.SessionKey != "").Select(e => e.SessionKey).Distinct().Count()} recorded sessions share this task.";
        CodeRelatedText.Text = related + "\nAuthorship is unknown. A shared task does not prove who made this change.";
        if (Privacy.Minimize(change.Current.Patch, RepositoryReader.MaxPatch) != change.Current.Patch.Trim())
            CodeRelatedText.Text += "\nPotential sensitive text detected. Local history is exact; inspect the minimized external preview carefully.";
        CodeDiffText.Text = "Previous snapshot patch (same layer)\n" + (change.PreviousPatch == "" ? "No prior patch.\n" : change.PreviousPatch) +
            "\nCurrent snapshot patch\n" + (change.Current.Patch == "" ? "No remaining diff in this layer.\n" : change.Current.Patch) +
            (change.Current.Reference == "" ? "" : "\nCommit reference: " + change.Current.Reference);
        var results = task is null ? Array.Empty<Observation>() : TaskService.Timeline(_state, task.Id).Where(e => e.Kind == "test_result").ToArray();
        CodeOutcomeText.Text = results.Length == 0 ? "Verification unknown: no process result is associated with this task. Commits and diffs do not establish success." :
            "Task process results (not proof that this exact snapshot was tested):\n" + string.Join("\n", results.TakeLast(5).Select(r => r.Summary + $" [{r.Basis}]"));
    }
    private void AssignChange_Click(object sender, RoutedEventArgs e) => Safe(() => {
        GuardLocal(); if (TaskId is not { } task || ChangeId is not { } change) return;
        _store.Update(s => { TaskService.Associate(s, new[] { change }, task); return true; }); CancelPreview(); Render(task);
    });
    private void AnalyzeChange_Click(object sender, RoutedEventArgs e) => Safe(() => {
        GuardLocal(); if (ChangeId is not { } change) return;
        if (!_state.Associations.TryGetValue(change, out var task)) throw new AnalysisFailure("Assign this change to a task before preparing its payload.");
        _queue.Clear(); ShowPreview(task, new[] { change });
    });
}
