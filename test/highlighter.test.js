'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createHighlighter, isSyslogDocument } = require('../src/highlighter');

function fixture(lines, visibleStart = 0, visibleEnd = lines.length - 1, { languageId = 'syslog', documentPath = '/sample.log' } = {}) {
  const listeners = {};
  const types = [];
  let enabled = true;
  let lineHighlight = true;
  let reads = 0;
  const document = {
    languageId, uri: { path: documentPath }, lineCount: lines.length,
    lineAt(line) { reads++; return { text: lines[line] }; }
  };
  const editor = {
    document,
    visibleRanges: [{ start: { line: visibleStart }, end: { line: visibleEnd } }],
    applied: new Map(),
    decorationCalls: 0,
    setDecorations(type, ranges) {
      this.decorationCalls++;
      this.applied.set((type.color ?? type.backgroundColor).id, ranges);
    }
  };
  const event = name => callback => {
    listeners[name] = callback;
    return { dispose() { delete listeners[name]; } };
  };
  class Range {
    constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
  }
  const vscode = {
    ThemeColor: class { constructor(id) { this.id = id; } }, Range,
    MarkdownString: class { constructor(value) { this.value = value; } },
    Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    window: {
      visibleTextEditors: [editor],
      createTextEditorDecorationType(options) {
        const type = { ...options, disposed: false, dispose() { this.disposed = true; } };
        types.push(type);
        return type;
      },
      onDidChangeVisibleTextEditors: event('editors'),
      onDidChangeTextEditorVisibleRanges: event('scroll')
    },
    workspace: {
      getConfiguration() {
        return { get(key, fallback) {
          if (key === 'enabled') return enabled;
          if (key === 'lineHighlight') return lineHighlight;
          return fallback;
        } };
      },
      onDidChangeTextDocument: event('change'),
      onDidChangeConfiguration: event('config'),
      onDidOpenTextDocument: event('open')
    },
    languages: {
      registerHoverProvider(selector, provider) {
        listeners.hover = provider.provideHover;
        return { dispose() { delete listeners.hover; } };
      }
    }
  };
  const highlighter = createHighlighter(vscode);
  return {
    highlighter, vscode, document, editor, listeners, types,
    setEnabled(value) { enabled = value; },
    setLineHighlight(value) { lineHighlight = value; },
    get reads() { return reads; }
  };
}

test('filename and explicit language identify supported documents', () => {
  assert.ok(isSyslogDocument({ languageId: 'log', uri: { path: '/remote/MIXED.LOG' } }));
  assert.ok(isSyslogDocument({ languageId: 'syslog', uri: { path: '/var/log/messages' } }));
  assert.equal(isSyslogDocument({ languageId: 'plaintext', uri: { path: '/readme.txt' } }), false);
});

test('BSD PRI stays neutral while hover and background reflect severity and facility', t => {
  const f = fixture(['<34>Oct 14 11:48:10 host app[123]: message', 'ordinary line']);
  t.after(() => f.highlighter.dispose());
  const ranges = f.editor.applied.get('syslogHighlight.critical');
  assert.equal(ranges.length, 0);
  assert.equal(f.editor.applied.get('syslogHighlight.hostname').length, 1);
  assert.equal(f.editor.applied.get('syslogHighlight.errorBackground').length, 1);
  const hover = f.listeners.hover(f.document, { line: 0, character: 2 });
  assert.match(hover.contents.value, /2 — Critical/);
  assert.match(hover.contents.value, /4 — auth/);
  assert.equal(f.listeners.hover(f.document, { line: 0, character: 4 }), undefined);
  assert.equal(f.listeners.hover(f.document, { line: 1, character: 0 }), undefined);
});

test('editing BSD severity refreshes backgrounds; disabling clears decorations and hover', async t => {
  const lines = ['<34>Oct 14 11:48:10 host app[123]: message'];
  const f = fixture(lines);
  t.after(() => f.highlighter.dispose());
  lines[0] = '<166>Oct 14 11:48:10 host app[123]: edited';
  f.listeners.change({ document: f.document });
  await delay(120);
  assert.equal(f.editor.applied.get('syslogHighlight.critical').length, 0);
  assert.equal(f.editor.applied.get('editor.foreground').length, 0);
  assert.equal(f.editor.applied.get('syslogHighlight.errorBackground').length, 0);
  f.setEnabled(false);
  f.listeners.config({ affectsConfiguration: () => true });
  assert.ok([...f.editor.applied.values()].every(ranges => ranges.length === 0));
  assert.equal(f.listeners.hover(f.document, { line: 0, character: 0 }), undefined);
  f.setEnabled(true);
  f.listeners.config({ affectsConfiguration: () => true });
  assert.equal(f.editor.applied.get('syslogHighlight.hostname').length, 1);
});

test('large files only read visible lines plus margin and repaint on scroll', async t => {
  const f = fixture(Array(10000).fill('<166>1 - host app 123 EVENT - message'), 100, 110);
  t.after(() => f.highlighter.dispose());
  assert.equal(f.reads, 51);
  f.editor.visibleRanges = [{ start: { line: 500 }, end: { line: 505 } }];
  f.listeners.scroll({ textEditor: f.editor });
  await delay(120);
  assert.equal(f.reads, 97);
  const ranges = f.editor.applied.get('syslogHighlight.hostname');
  assert.equal(ranges[0].start.line, 480);
  assert.equal(ranges.at(-1).end.line, 525);
});

test('split editors update together and disposal cancels pending work', async () => {
  const f = fixture(['<34>1 - host app 123 EVENT - message']);
  const split = { ...f.editor, applied: new Map() };
  f.vscode.window.visibleTextEditors.push(split);
  f.listeners.editors(f.vscode.window.visibleTextEditors);
  assert.equal(split.applied.get('syslogHighlight.hostname').length, 1);
  f.listeners.change({ document: f.document });
  const readsBeforeDisposal = f.reads;
  f.highlighter.dispose();
  await delay(120);
  assert.equal(f.reads, readsBeforeDisposal);
  assert.ok(f.types.every(type => type.disposed));
  assert.equal(Object.keys(f.listeners).length, 0);
});

test('a change to an unsupported language clears decorations for extensionless documents', t => {
  const f = fixture(['<34>1 - host app 123 EVENT - message']);
  t.after(() => f.highlighter.dispose());
  f.document.uri.path = '/var/log/messages';
  f.document.languageId = 'plaintext';
  f.listeners.open(f.document);
  assert.ok([...f.editor.applied.values()].every(ranges => ranges.length === 0));
});

test('RFC5424 ROS 2 errors tint the whole line with neutral PRI text and intact hover', t => {
  const f = fixture(['<166>1 - host ros2 123 EVENT - [ERROR] [node]: failed']);
  t.after(() => f.highlighter.dispose());
  const ranges = f.editor.applied.get('syslogHighlight.error');
  assert.equal(ranges.length, 1);
  const pri = f.editor.applied.get('editor.foreground');
  assert.equal(pri.length, 0);
  assert.ok(ranges[0].start.character > 5);
  const backgrounds = f.editor.applied.get('syslogHighlight.errorBackground');
  assert.equal(backgrounds.length, 1);
  assert.deepEqual(backgrounds[0].start, { line: 0, character: 0 });
  assert.equal(backgrounds[0].end.character, f.document.lineAt(0).text.length);
  const backgroundType = f.types.find(type => type.backgroundColor?.id === 'syslogHighlight.errorBackground');
  assert.equal(backgroundType.isWholeLine, true);
  assert.equal(backgroundType.color, undefined);
  const hover = f.listeners.hover(f.document, { line: 0, character: 2 });
  assert.match(hover.contents.value, /PRI: 166/);
  assert.match(hover.contents.value, /Severity: \*\*6 — Informational/);
  assert.match(hover.contents.value, /20 — local4/);
  assert.match(hover.contents.value, /ROS 2 message level: \*\*\[ERROR\] — Error/);
  assert.doesNotMatch(hover.contents.value, /overrides PRI/);
});

test('disabling line highlights clears only backgrounds and preserves foregrounds and hover', t => {
  const f = fixture(['<166>1 - host ros2 123 EVENT - [ERROR] [node]: failed']);
  t.after(() => f.highlighter.dispose());
  f.setLineHighlight(false);
  f.listeners.config({ affectsConfiguration: () => true });
  assert.equal(f.editor.applied.get('syslogHighlight.error').length, 1);
  assert.equal(f.editor.applied.get('editor.foreground').length, 0);
  assert.equal(f.editor.applied.get('syslogHighlight.errorBackground').length, 0);
  assert.match(f.listeners.hover(f.document, { line: 0, character: 2 }).contents.value, /ROS 2/);
  f.setLineHighlight(true);
  f.listeners.config({ affectsConfiguration: () => true });
  assert.equal(f.editor.applied.get('syslogHighlight.errorBackground').length, 1);
  assert.equal(f.editor.applied.get('syslogHighlight.error').length, 1);
  assert.equal(f.editor.applied.get('editor.foreground').length, 0);
});

test('editing a ROS 2 level or removing it updates backgrounds and leaves PRI color unchanged', async t => {
  const prefix = '<166>1 - host ros2 123 EVENT - ';
  const lines = [prefix + '[ERROR] [node]: failed'];
  const f = fixture(lines);
  t.after(() => f.highlighter.dispose());
  lines[0] = prefix + '[WARN] [node]: low battery';
  f.listeners.change({ document: f.document });
  await delay(120);
  assert.equal(f.editor.applied.get('syslogHighlight.error').length, 0);
  assert.equal(f.editor.applied.get('syslogHighlight.warning').length, 1);
  assert.equal(f.editor.applied.get('syslogHighlight.errorBackground').length, 0);
  assert.equal(f.editor.applied.get('syslogHighlight.warningBackground').length, 1);
  assert.equal(f.editor.applied.get('editor.foreground').length, 0);
  lines[0] = prefix + 'ordinary text';
  f.listeners.change({ document: f.document });
  await delay(120);
  assert.equal(f.editor.applied.get('syslogHighlight.warning').length, 0);
  assert.equal(f.editor.applied.get('editor.foreground').length, 0);
  assert.equal(f.editor.applied.get('syslogHighlight.warningBackground').length, 0);
});

test('the supplied PRI-less BSD examples decorate INFO/WARN labels in the editor', t => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures/ros2-bsd.log'), 'utf8').trimEnd().split('\n');
  const f = fixture(lines);
  t.after(() => f.highlighter.dispose());
  for (const [line, color, level] of [[0, 'editor.foreground', 'INFO'], [1, 'syslogHighlight.warning', 'WARN']]) {
    const ranges = f.editor.applied.get(color);
    assert.equal(ranges.length, 1);
    const marker = `[${level} 1791946090.744912205]`;
    assert.deepEqual(ranges[0].start, { line, character: lines[line].indexOf(marker) });
    assert.deepEqual(ranges[0].end, { line, character: lines[line].indexOf(marker) + marker.length });
  }
  assert.deepEqual(f.editor.applied.get('syslogHighlight.warningBackground').map(range => range.start.line), [1]);
  assert.equal(f.editor.applied.get('syslogHighlight.errorBackground').length, 0);
  f.setLineHighlight(false);
  f.listeners.config({ affectsConfiguration: () => true });
  assert.equal(f.editor.applied.get('syslogHighlight.warning').length, 1);
  assert.equal(f.editor.applied.get('syslogHighlight.warningBackground').length, 0);
  f.setEnabled(false);
  f.listeners.config({ affectsConfiguration: () => true });
  assert.ok([...f.editor.applied.values()].every(ranges => ranges.length === 0));
});

test('Emergency, Alert, Critical, and Error remain red in both formats; Warning uses amber', t => {
  for (const header of ['1 - host app 123 EVENT - ', 'Oct 14 11:48:10 host app[123]: ']) {
    const lines = Array.from({ length: 8 }, (_, severity) => `<${160 + severity}>${header}message`);
    const f = fixture(lines);
    t.after(() => f.highlighter.dispose());
    assert.deepEqual(f.editor.applied.get('syslogHighlight.errorBackground').map(range => range.start.line), [0, 1, 2, 3]);
    assert.deepEqual(f.editor.applied.get('syslogHighlight.warningBackground').map(range => range.start.line), [4]);
  }
});

test('BSD ROS 2 ERROR/FATAL tint red, WARN orange, and INFO/DEBUG have no background', t => {
  const levels = ['ERROR', 'FATAL', 'WARN', 'INFO', 'DEBUG'];
  const lines = levels.map(level => `Oct 14 11:48:10 aaa bbb-manager[4716]: [bbb-manager-1] [${level} 1791946090.744912205] [bbb-manager] details`);
  const f = fixture(lines);
  t.after(() => f.highlighter.dispose());
  assert.deepEqual(f.editor.applied.get('syslogHighlight.errorBackground').map(range => range.start.line), [0, 1]);
  assert.deepEqual(f.editor.applied.get('syslogHighlight.warningBackground').map(range => range.start.line), [2]);
  assert.equal(f.editor.applied.get('syslogHighlight.hostname').length, 5);
});

test('ROS 2 INFO suppresses a syslog error background and RFC5424 PRI remains neutral', t => {
  const f = fixture(['<163>1 - host ros2 123 EVENT - [INFO] [node]: ready']);
  t.after(() => f.highlighter.dispose());
  const pri = f.editor.applied.get('syslogHighlight.error');
  assert.equal(pri.length, 0);
  assert.equal(f.editor.applied.get('syslogHighlight.errorBackground').length, 0);
  assert.equal(f.editor.applied.get('syslogHighlight.warningBackground').length, 0);
});

test('all PRI values in both formats have no foreground decoration, with or without ROS 2 labels', t => {
  for (const header of ['1 - host app 123 EVENT - ', 'Oct 14 11:48:10 host app[123]: ']) {
    for (const message of ['ordinary text', '[WARN] [node]: low battery']) {
      const lines = Array.from({ length: 192 }, (_, pri) => `<${pri}>${header}${message}`);
      const f = fixture(lines);
      t.after(() => f.highlighter.dispose());
      for (const type of f.types.filter(type => type.color)) {
        for (const range of f.editor.applied.get(type.color.id)) {
          const priEnd = lines[range.start.line].indexOf('>') + 1;
          assert.ok(range.start.character >= priEnd, `Foreground on PRI at line ${range.start.line}`);
        }
      }
      const hover = f.listeners.hover(f.document, { line: 191, character: 2 });
      assert.match(hover.contents.value, /PRI: 191/);
      assert.match(hover.contents.value, /7 — Debug/);
    }
  }
});

test('the four supplied BSD records have neutral PRI text and retain label colors and backgrounds', t => {
  const lines = [
    '<166>Oct 15 09:04:07 robot ros2[200]: [WARN] [1792022647.000] [controller]: Battery low',
    '<166>Oct 15 09:04:08 robot ros2[200]: [INFO] [1792022648.000] [controller]: The message mentions ERROR but keeps the INFO color',
    '<34>Oct 15 09:03:00 auth sshd[1234]: Authentication failed',
    '<13>Oct 15 09:03:01 workstation app: Notice from BSD syslog'
  ];
  const f = fixture(lines);
  t.after(() => f.highlighter.dispose());
  for (const type of f.types.filter(type => type.color)) {
    for (const range of f.editor.applied.get(type.color.id)) {
      assert.ok(range.start.character >= lines[range.start.line].indexOf('>') + 1);
    }
  }
  assert.equal(f.editor.applied.get('syslogHighlight.warning').length, 1);
  assert.equal(f.editor.applied.get('editor.foreground').length, 1);
  assert.deepEqual(f.editor.applied.get('syslogHighlight.warningBackground').map(range => range.start.line), [0]);
  assert.deepEqual(f.editor.applied.get('syslogHighlight.errorBackground').map(range => range.start.line), [2]);
  const hover = f.listeners.hover(f.document, { line: 2, character: 2 });
  assert.match(hover.contents.value, /2 — Critical/);
});

test('INFO markers in both formats use editor.foreground directly, including after edits', async t => {
  const lines = [
    '<166>1 - host ros2 123 EVENT - [INFO] [node]: ready',
    '<166>Oct 15 09:04:08 robot ros2[200]: [INFO] [node]: ready',
    'Oct 14 11:48:10 aaa bbb-manager[4716]: [bbb-manager-1] [INFO 1791946090.744912205] [bbb-manager] ready'
  ];
  const f = fixture(lines);
  t.after(() => f.highlighter.dispose());
  assert.equal(f.editor.applied.has('syslogHighlight.informational'), false);
  assert.equal(f.editor.applied.get('editor.foreground').length, 3);
  const type = f.types.find(type => type.color?.id === 'editor.foreground');
  assert.equal(type.fontWeight, undefined);
  for (const range of f.editor.applied.get('editor.foreground')) {
    assert.ok(lines[range.start.line].slice(range.start.character, range.end.character).startsWith('[INFO'));
  }
  lines[0] = '<166>1 - host ros2 123 EVENT - [DEBUG] [node]: trace';
  f.listeners.change({ document: f.document });
  await delay(120);
  assert.equal(f.editor.applied.get('editor.foreground').length, 2);
  assert.equal(f.editor.applied.get('syslogHighlight.debug').length, 1);
});

test('unrelated files never read lines or update decorations for editor events', async t => {
  const f = fixture(['const value = 1;'], 0, 0, { languageId: 'javascript', documentPath: '/app.js' });
  t.after(() => f.highlighter.dispose());
  f.listeners.scroll({ textEditor: f.editor });
  f.listeners.change({ document: f.document });
  f.listeners.open(f.document);
  f.listeners.config({ affectsConfiguration: () => true });
  f.listeners.editors([f.editor]);
  await delay(120);
  assert.equal(f.reads, 0);
  assert.equal(f.editor.decorationCalls, 0);
});

test('changing to an unrelated language clears existing decorations once', t => {
  const f = fixture(['<34>1 - host app 123 EVENT - message']);
  t.after(() => f.highlighter.dispose());
  f.document.uri.path = '/var/log/messages';
  f.document.languageId = 'plaintext';
  f.listeners.open(f.document);
  assert.ok([...f.editor.applied.values()].every(ranges => ranges.length === 0));
  const callsAfterClear = f.editor.decorationCalls;
  f.listeners.open(f.document);
  f.listeners.scroll({ textEditor: f.editor });
  assert.equal(f.editor.decorationCalls, callsAfterClear);
});

test('an immediate settings refresh cancels a pending edit refresh', async t => {
  const f = fixture(['<34>1 - host app 123 EVENT - message']);
  t.after(() => f.highlighter.dispose());
  f.listeners.change({ document: f.document });
  f.listeners.config({ affectsConfiguration: () => true });
  const readsAfterRefresh = f.reads;
  const callsAfterRefresh = f.editor.decorationCalls;
  await delay(120);
  assert.equal(f.reads, readsAfterRefresh);
  assert.equal(f.editor.decorationCalls, callsAfterRefresh);
});
