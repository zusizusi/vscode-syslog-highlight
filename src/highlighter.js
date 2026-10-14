'use strict';

const { parseLine, SEVERITIES, FACILITIES, ROS2_SEVERITIES } = require('./parser');
const FIELDS = ['version', 'timestamp', 'hostname', 'appName', 'procId', 'msgId', 'structuredData'];

function isSyslogDocument(document) {
  return document.languageId === 'syslog' || /\.(?:log|syslog)$/i.test(document.uri.path);
}

function createHighlighter(vscode) {
  const disposables = [];
  const timers = new Map();
  const decorations = new Map();
  const decoratedEditors = new WeakSet();

  function addDecoration(kind, options) {
    const type = vscode.window.createTextEditorDecorationType({
      ...options,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    decorations.set(kind, type);
    disposables.push(type);
  }

  for (const severity of Object.values(ROS2_SEVERITIES)) {
    const kind = SEVERITIES[severity].key;
    addDecoration(kind, {
      color: new vscode.ThemeColor(kind === 'informational' ? 'editor.foreground' : `syslogHighlight.${kind}`),
      fontWeight: severity <= 3 ? 'bold' : undefined
    });
  }
  for (const kind of FIELDS) {
    addDecoration(kind, { color: new vscode.ThemeColor(`syslogHighlight.${kind}`) });
  }
  for (const kind of ['warningBackground', 'errorBackground']) {
    addDecoration(kind, {
      backgroundColor: new vscode.ThemeColor(`syslogHighlight.${kind}`),
      isWholeLine: true
    });
  }

  function enabled(document) {
    return isSyslogDocument(document) && vscode.workspace.getConfiguration('syslogHighlight', document.uri).get('enabled', true);
  }

  function cancelUpdate(editor) {
    clearTimeout(timers.get(editor));
    timers.delete(editor);
  }

  function clearDecorations(editor) {
    if (!decoratedEditors.has(editor)) return;
    for (const type of decorations.values()) editor.setDecorations(type, []);
    decoratedEditors.delete(editor);
  }

  function update(editor) {
    cancelUpdate(editor);
    if (!isSyslogDocument(editor.document)) {
      clearDecorations(editor);
      return;
    }
    const configuration = vscode.workspace.getConfiguration('syslogHighlight', editor.document.uri);
    if (!configuration.get('enabled', true)) {
      clearDecorations(editor);
      return;
    }
    const ranges = new Map([...decorations.keys()].map(kind => [kind, []]));
    const highlightLines = configuration.get('lineHighlight', true);
    // Work scales with the viewport, not with the size of a log file.
    const lines = new Set();
    for (const range of editor.visibleRanges) {
      const start = Math.max(0, range.start.line - 20);
      const end = Math.min(editor.document.lineCount - 1, range.end.line + 20);
      for (let line = start; line <= end; line++) lines.add(line);
    }
    for (const line of lines) {
      const text = editor.document.lineAt(line).text;
      const parsed = parseLine(text);
      if (!parsed) continue;
      for (const item of parsed.tokens) {
        ranges.get(item.kind).push(new vscode.Range(line, item.start, line, item.end));
      }
      if (highlightLines) {
        const kind = parsed.highlightSeverity === 4 ? 'warningBackground'
          : parsed.highlightSeverity <= 3 ? 'errorBackground' : undefined;
        if (kind) ranges.get(kind).push(new vscode.Range(line, 0, line, text.length));
      }
    }
    for (const [kind, type] of decorations) editor.setDecorations(type, ranges.get(kind));
    decoratedEditors.add(editor);
  }

  function schedule(editor) {
    cancelUpdate(editor);
    if (!enabled(editor.document)) {
      clearDecorations(editor);
      return;
    }
    timers.set(editor, setTimeout(() => {
      timers.delete(editor);
      if (vscode.window.visibleTextEditors.includes(editor)) update(editor);
    }, 80));
  }

  disposables.push(
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of timers.keys()) {
        if (!editors.includes(editor)) {
          cancelUpdate(editor);
        }
      }
      editors.forEach(update);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(event => schedule(event.textEditor)),
    vscode.workspace.onDidChangeTextDocument(event => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === event.document) schedule(editor);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('syslogHighlight')) vscode.window.visibleTextEditors.forEach(update);
    }),
    vscode.workspace.onDidOpenTextDocument(document => {
      // Language-mode changes also reopen the document through this event.
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === document) update(editor);
      }
    }),
    vscode.languages.registerHoverProvider('*', {
      provideHover(document, position) {
        if (!enabled(document)) return undefined;
        const parsed = parseLine(document.lineAt(position.line).text);
        if (!parsed || parsed.priority === undefined) return undefined;
        const pri = parsed.priRange;
        if (position.character < pri.start || position.character >= pri.end) return undefined;
        const range = new vscode.Range(position.line, pri.start, position.line, pri.end);
        const content = new vscode.MarkdownString(
          `**${parsed.format} PRI: ${parsed.priority}**\n\n` +
          `Severity: **${parsed.severity} — ${SEVERITIES[parsed.severity].name}**\n\n` +
          `Facility: **${parsed.facility} — ${FACILITIES[parsed.facility]}**\n\n` +
          (parsed.ros2Severity
            ? `ROS 2 message level: **[${parsed.ros2Severity.level}] — ${SEVERITIES[parsed.highlightSeverity].name}**\n\n`
            : '') +
          '`PRI = facility × 8 + severity`'
        );
        return new vscode.Hover(content, range);
      }
    })
  );

  vscode.window.visibleTextEditors.forEach(update);
  return {
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      disposables.forEach(item => item.dispose());
    }
  };
}

module.exports = { createHighlighter, isSyslogDocument };
