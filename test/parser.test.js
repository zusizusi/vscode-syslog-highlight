'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseLine, SEVERITIES } = require('../src/parser');

const header = '1 2026-10-15T09:00:00.123+09:00 host.example app 123 EVENT ';
const record = (pri = 34, sd = '-', message = 'message') => `<${pri}>${header}${sd} ${message}`;
const textFor = (line, parsed, kind) => {
  const item = parsed.tokens.find(item => item.kind === kind);
  return line.slice(item.start, item.end);
};

test('all 192 priorities decode severity, facility, and the exact PRI range', () => {
  for (let priority = 0; priority <= 191; priority++) {
    const line = record(priority);
    const parsed = parseLine(line);
    assert.equal(parsed.format, 'RFC5424');
    assert.equal(parsed.priority, priority);
    assert.equal(parsed.severity, priority % 8);
    assert.equal(parsed.facility, Math.floor(priority / 8));
    assert.equal(line.slice(parsed.priRange.start, parsed.priRange.end), `<${priority}>`);
    assert.ok(parsed.tokens.every(item => item.start >= parsed.priRange.end));
  }
});

test('RFC5424 fields have correct boundaries and never include the message', () => {
  const line = record();
  const parsed = parseLine(line);
  for (const [kind, value] of Object.entries({
    version: '1', timestamp: '2026-10-15T09:00:00.123+09:00', hostname: 'host.example',
    appName: 'app', procId: '123', msgId: 'EVENT', structuredData: '-'
  })) assert.equal(textFor(line, parsed, kind), value);
  assert.equal(parsed.tokens.at(-1).end, line.indexOf(' message'));
});

test('NILVALUE, SD-only records, and empty messages are accepted', () => {
  assert.equal(parseLine('<0>1 - - - - - -').severity, 0);
  assert.ok(parseLine(`<165>${header}[meta]`));
  assert.ok(parseLine(`<165>${header}- `));
  assert.ok(parseLine(record(165, '[meta value=""]')));
});

test('escaped quotes, backslashes, brackets, Unicode, and consecutive SD elements', () => {
  const sd = String.raw`[meta@32473 value="日本語😀 \] \" \\" other="ok"][trace id="42"]`;
  const line = record(166, sd, '[this is part of the message]');
  const parsed = parseLine(line);
  assert.ok(parsed);
  assert.equal(textFor(line, parsed, 'structuredData'), sd);
  assert.equal(parsed.tokens.at(-1).end, line.indexOf(' [this'));
  // '[' is allowed in an SD-NAME by RFC5424.
  assert.ok(parseLine(record(166, '[id[ param[="ok"]')));
});

test('RFC5424 timestamps: NILVALUE, timezone, precision, and leap-day boundaries', () => {
  for (const timestamp of ['-', '2026-10-15T00:00:00Z', '2024-02-29T23:59:59.123456-09:30']) {
    assert.ok(parseLine(`<34>1 ${timestamp} h a p m -`), timestamp);
  }
  for (const timestamp of [
    '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-10-15T24:00:00Z', '2026-10-15T00:00:60Z', '2026-10-15T00:00:00',
    '2026-10-15t00:00:00z', '2026-10-15T00:00:00.1234567Z'
  ]) assert.equal(parseLine(`<34>1 ${timestamp} h a p m -`), undefined, timestamp);
});

test('malformed or unrelated records do not get syslog decorations', () => {
  for (const line of [
    '', 'ordinary text', '2026-10-15 09:00:00 INFO message',
    record(192), record(999), record('034'), record('-1'), record(''),
    '<34>1 2026-10-15T00:00:00Z host app missing fields',
    '<34>2 - host app 123 EVENT - message',
    record(34, 'not-structured-data'), record(34, '-suffix'),
    record(34, '[meta value="unterminated]'), record(34, '[meta value="unescaped ]"]'),
    record(34, String.raw`[meta value="invalid \q"]`), record(34, '[]'),
    record(34, '[meta name=unquoted]'), record(34, '[meta ]'), record(34, '[meta]suffix'),
    '<34>1 - host ' + 'a'.repeat(49) + ' 123 EVENT - message',
    '<34>Foo 15 09:00:00 host app: message', '<34>Oct 15 29:00:00 host app: message'
  ]) assert.equal(parseLine(line), undefined, line);
});

test('BSD with PRI, tag, PID, IPv6, and one-digit space-padded day', () => {
  const line = '<13>Oct  5 09:03:02 2001:db8::1 sshd[1234]: message';
  const parsed = parseLine(line);
  assert.equal(parsed.format, 'BSD');
  assert.equal(parsed.severity, 5);
  assert.equal(parsed.facility, 1);
  assert.equal(line.slice(parsed.priRange.start, parsed.priRange.end), '<13>');
  assert.equal(textFor(line, parsed, 'timestamp'), 'Oct  5 09:03:02');
  assert.equal(textFor(line, parsed, 'hostname'), '2001:db8::1');
  assert.equal(textFor(line, parsed, 'appName'), 'sshd');
  assert.equal(textFor(line, parsed, 'procId'), '1234');
});

test('BSD disk logs without PRI do not invent a severity', () => {
  const line = 'Oct 15 09:03:00 host kernel: Critical error mentioned in message';
  const parsed = parseLine(line);
  assert.equal(parsed.format, 'BSD');
  assert.equal(parsed.priority, undefined);
  assert.equal(parsed.priRange, undefined);
  assert.equal(parsed.severity, undefined);
  assert.equal(textFor(line, parsed, 'appName'), 'kernel');
  assert.equal(parsed.tokens.length, 3);
  assert.equal(parseLine('Oct 15 09:03:00 host free form text').tokens.length, 2);
});

test('BOM is excluded from the PRI decoration range', () => {
  const line = '\uFEFF' + record();
  const parsed = parseLine(line);
  assert.equal(parsed.priRange.start, 1);
  assert.equal(line.slice(parsed.priRange.start, parsed.priRange.end), '<34>');
});

test('ROS 2 levels select line highlights while the decoded PRI severity is preserved', () => {
  for (const [level, severity] of Object.entries({ FATAL: 2, ERROR: 3, WARN: 4, INFO: 6, DEBUG: 7 })) {
    const line = record(166, '-', `[${level}] [1792022400.123456789] [node]: message`);
    const parsed = parseLine(line);
    assert.equal(parsed.priority, 166);
    assert.equal(parsed.severity, 6);
    assert.equal(parsed.facility, 20);
    assert.deepEqual(parsed.ros2Severity, { level, severity });
    assert.equal(parsed.highlightSeverity, severity);
    assert.equal(line.slice(parsed.priRange.start, parsed.priRange.end), '<166>');
    assert.equal(parsed.tokens.length, 8);
    const label = parsed.tokens.at(-1);
    assert.equal(label.kind, SEVERITIES[severity].key);
    assert.equal(line.slice(label.start, label.end), `[${level}]`);
  }
});

test('ROS 2 launch prefixes, whitespace, BOM, legacy formats, and ANSI colors are recognized', () => {
  for (const message of [
    '[controller-1] [ERROR] [1792022400.123] [controller]: failed',
    '[component_container-12] [ERROR] [node]: failed',
    '  \uFEFF[ ERROR ] [node]: failed',
    '[ERROR 1792022400.123456789] [node]: failed',
    '\x1b[31m[ERROR]\x1b[0m [node]: failed',
    '[controller-1] \x1b[1;31m[ERROR] [1792022400.123] [controller]: failed\x1b[0m'
  ]) assert.equal(parseLine(record(166, '-', message)).highlightSeverity, 3, message);
});

test('ROS 2 recognition uses only MSG, not RFC5424 headers or structured data', () => {
  const lines = [
    '<166>1 - [ERROR] [WARN] [DEBUG] [FATAL] - ordinary text',
    record(166, String.raw`[meta level="[ERROR\]"]`, 'ordinary text'),
    `<166>${header}[ERROR]`,
    `<166>${header}-`
  ];
  for (const line of lines) {
    const parsed = parseLine(line);
    assert.equal(parsed.severity, 6, line);
    assert.equal(parsed.ros2Severity, undefined, line);
  }
});

test('ordinary words and markers later in the message cannot change line highlights', () => {
  for (const message of [
    'ERROR occurred', 'WARN about INFO', 'message mentions [ERROR]',
    '[node]: received [ERROR]', '[ERROR_COUNT] 42', '[ERROR]suffix', '[TRACE] [ERROR] details'
  ]) {
    assert.equal(parseLine(record(166, '-', message)).highlightSeverity, 6, message);
  }
  const parsed = parseLine(record(166, '-', '[INFO] [node]: received [ERROR] from another node'));
  assert.equal(parsed.highlightSeverity, 6);
  assert.equal(parsed.ros2Severity.level, 'INFO');
});

test('BSD ROS 2 logs support tags, process IDs, and untagged messages', () => {
  for (const prefix of ['ros2[123]: ', 'ros2: ', '']) {
    const line = `<166>Oct 15 09:00:00 host ${prefix}[WARN] [node]: low battery`;
    const parsed = parseLine(line);
    assert.equal(parsed.format, 'BSD');
    assert.equal(parsed.severity, 6);
    assert.equal(parsed.highlightSeverity, 4);
    assert.equal(line.slice(parsed.priRange.start, parsed.priRange.end), '<166>');
    assert.equal(textFor(line, parsed, 'warning'), '[WARN]');
  }
  const parsed = parseLine('Oct 15 09:00:00 host ros2: [ERROR] [node]: failed');
  assert.equal(parsed.priority, undefined);
  assert.equal(parsed.severity, undefined);
  assert.equal(parsed.tokens.at(-1).kind, 'error');
  assert.equal(parsed.ros2Severity.level, 'ERROR');
});

test('all PRI values retain their original metadata independently of ROS 2 levels', () => {
  for (let priority = 0; priority <= 191; priority++) {
    const line = record(priority, '-', '[WARN] [node]: low battery');
    const parsed = parseLine(line);
    assert.equal(parsed.severity, priority % 8);
    assert.equal(parsed.highlightSeverity, 4);
    assert.equal(line.slice(parsed.priRange.start, parsed.priRange.end), `<${priority}>`);
    assert.ok(parsed.tokens.every(item => item.start >= parsed.priRange.end));
  }
});

test('the supplied BSD examples without PRI color the entire INFO/WARN label', () => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures/ros2-bsd.log'), 'utf8').trimEnd().split('\n');
  for (const [index, line] of lines.entries()) {
    const parsed = parseLine(line);
    const level = index === 0 ? 'INFO' : 'WARN';
    const kind = index === 0 ? 'informational' : 'warning';
    assert.equal(parsed.format, 'BSD');
    assert.equal(parsed.priority, undefined);
    assert.equal(parsed.severity, undefined);
    assert.equal(parsed.highlightSeverity, index === 0 ? 6 : 4);
    assert.equal(textFor(line, parsed, 'appName'), 'bbb-manager');
    assert.equal(textFor(line, parsed, 'procId'), '4716');
    const label = parsed.tokens.at(-1);
    assert.equal(label.kind, kind);
    assert.equal(line.slice(label.start, label.end), `[${level} 1791946090.744912205]`);
    assert.equal(label.start, line.indexOf(`[${level}`));
    assert.equal(parsed.tokens.length, 5);
  }
});

test('ROS 2 label ranges retain exact UTF-16 columns across ANSI colors and Unicode prefixes', () => {
  for (const marker of ['[ERROR]', '[ERROR 1791946090.744912205]']) {
    const line = `Oct 14 11:48:10 aaa ros2[4716]: \x1b[36m[ノード😀-1]\x1b[0m \x1b[1;31m${marker}\x1b[0m [logger]: detail`;
    const parsed = parseLine(line);
    const label = parsed.tokens.at(-1);
    assert.equal(label.start, line.indexOf(marker));
    assert.equal(label.end, line.indexOf(marker) + marker.length);
    assert.equal(line.slice(label.start, label.end), marker);
    assert.equal(label.kind, 'error');
  }
});

test('SD IDs and parameter names share the same ASCII and 32-character boundaries', () => {
  for (const name of ['x', 'x'.repeat(32), 'name[with-bracket', 'meta@32473']) {
    assert.ok(parseLine(record(166, `[${name}]`)), `SD-ID ${name}`);
    assert.ok(parseLine(record(166, `[meta ${name}="value"]`)), `PARAM-NAME ${name}`);
  }
  for (const name of ['', 'x'.repeat(33), 'name"', 'name=', 'name]', '名前', '\t', '\u007F']) {
    assert.equal(parseLine(record(166, `[${name}]`)), undefined, `SD-ID ${name}`);
    assert.equal(parseLine(record(166, `[meta ${name}="value"]`)), undefined, `PARAM-NAME ${name}`);
  }
});
