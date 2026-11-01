# Human-readable coding insights

The Windows Codex dashboard now shows Activity Summary, Session History,
Recurring Patterns, Activity Statistics, and Tool Category Breakdown. Refresh
and the 20-second automatic refresh are preserved. Session details expand into
recorded timelines, within a bounded scrolling history area.

## Interpretation rules

- Today means the current Windows local calendar date. Last 7 days means today
  and the preceding six local calendar dates, not a rolling 168 hours.
  Available history includes all readable retained records. Future timestamps
  are excluded. Every event-based section uses the same filtered records.
- Collector status and approved-project count describe current consent, and
  are explicitly presented separately from historical statistics.
- Sessions count distinct valid identifiers with any recorded event in the
  selected period, including sessions whose start was not retained. This
  replaces the previous start-event-only session count. Events missing valid
  identifiers contribute to event/tool totals but not session histories or
  recurring patterns; the summary reports that limitation.
- Session counts and descriptions report only observed prompts and tool
  categories. End records do not imply successful task completion. Command
  content, prompt content, intent, productivity, and skill are never inferred.
- Duration requires exactly one start and one end in the selected period,
  strictly increasing timestamps, and all observed session events inside those
  boundaries. Otherwise duration is unavailable. A filter can truncate a
  session; records outside the selected period are not used to fill gaps.
- Timeline order is by timestamp. Equal timestamps are explicitly unordered.
  The first 12 distinct timestamps are displayed with an explicit remainder
  count; all selected events still contribute to totals and pattern analysis.
- A majority summary requires strictly more than half of recorded tool
  operations to belong to one category. Ties do not imply a dominant activity.
- A recurring pattern requires at least three distinct supporting sessions.
  Inspection-to-edit and edit-to-test/build require consecutive recorded tool
  operations with strictly ordered timestamps. Repeated command-line or
  inspection patterns require at least two consecutive matching tool operations.
  Intervening non-tool events do not break these tool sequences. Timestamps
  shared by multiple tool records cannot establish sequence evidence.
  The multiple-prompt pattern requires at least three prompts per supporting
  session. Every finding reports its supporting-session count and is worded
  as a possible workflow, never an inferred purpose or successful outcome.

Missing records can hide patterns; the analysis does not reconstruct missing
work. Malformed/unknown events are skipped and unknown tool categories become
Other. Counts refer to recorded events: the collector supplies no unique event
identifier with which to safely deduplicate repeated tool records. Repeated
records within a session cannot inflate the distinct-session pattern threshold.
Unreadable files produce an explicit incomplete-results warning.

## Privacy and architecture

`CodexActivityReader` reads only the current Windows user's existing local store.
`CodexInsights` is a deterministic local interpretation layer. Identifiers remain
inside its grouping inputs; returned display models contain only allowlisted
labels, numbers, timestamps, and generated prose. No raw event content, paths,
identifiers, prompts, commands, or credentials appear in display models.

Reading and analysis both run inside the existing worker task. Changing a time
filter clears the previous results; a read for an obsolete filter is discarded
and the latest selection is read next. No local information is passed into
WebView2, sent to the hosted React application, or uploaded to a service.

The collector, consent/pause/deletion/retention controls, web authentication,
notification and acknowledgment handlers, and tray behavior are unchanged.
There are no external AI dependencies.

## Validation

Run:

```powershell
dotnet run --project desktop/GentleControlRoom.Desktop.Tests
python -m unittest discover -s integrations/codex/tests
dotnet build desktop/GentleControlRoom.Desktop/GentleControlRoom.Desktop.csproj -o .artifacts/coding-insights
```

Synthetic fixtures cover shuffled records, grouping, counts, chronological
order, reliable/incomplete/ambiguous/reversed boundaries, evidence thresholds,
repeated records, missing identifiers, local-date filter boundaries,
filter-clipped sessions, equal timestamps, malformed records, future events,
unknown categories, empty periods, and output privacy. Fixtures use temporary
stores and do not modify the current user's activity or consent.

Validation on October 31, 2026: all 28 desktop-reader assertions and all 17
collector tests passed. The final Windows build completed with zero warnings
and errors. An isolated executable launched with a responsive Gentle Control
Room window and a successful WebView2 initialization marker.

The Windows UI helper repeatedly timed out, including recovery attempts. Native
visual checks, authentication, real background alert acknowledgment, and tray
interactions remain unverified and require an interactive Windows pass.
Automated reader tests and compilation do not replace those end-to-end checks.
