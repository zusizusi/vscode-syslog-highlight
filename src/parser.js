'use strict';

const SEVERITIES = [
  { key: 'emergency', name: 'Emergency' },
  { key: 'alert', name: 'Alert' },
  { key: 'critical', name: 'Critical' },
  { key: 'error', name: 'Error' },
  { key: 'warning', name: 'Warning' },
  { key: 'notice', name: 'Notice' },
  { key: 'informational', name: 'Informational' },
  { key: 'debug', name: 'Debug' }
];

const FACILITIES = [
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
  'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock',
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'
];

const PRI = /^<(0|[1-9]\d{0,2})>/;
const RFC_HEADER = /^(1) (\S+) ([!-~]{1,255}) ([!-~]{1,48}) ([!-~]{1,128}) ([!-~]{1,32}) /;
const RFC_FIELDS = ['version', 'timestamp', 'hostname', 'appName', 'procId', 'msgId'];
const RFC_TIMESTAMP = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const BSD_HEADER = /^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d) ([!-~]+)(?: |$)/;
const BSD_TAG = /^([\w./-]+)(?:\[(\d+)\])?:/;
const ROS2_SEVERITIES = { FATAL: 2, ERROR: 3, WARN: 4, INFO: 6, DEBUG: 7 };
// Match a level marker at the start of MSG, optionally after a ros2 launch process
// prefix. Support both [ERROR] and the older [ERROR 1234.567] console format.
const ROS2_LEVEL = /^\s*(?:\[[^\]\r\n]+-\d+\]\s*)?(\[\s*(DEBUG|INFO|WARN|ERROR|FATAL)(?:\s+\d+(?:\.\d+)?)?\s*\])(?=\s|$)/;
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

function detectRos2Severity(message) {
  const hasAnsi = message.includes('\x1b[');
  const plain = hasAnsi ? message.replace(ANSI_SGR, '') : message;
  const match = ROS2_LEVEL.exec(plain);
  if (!match) return undefined;
  // Decorations use the original UTF-16 columns, before ANSI codes were removed.
  function originalIndex(index) {
    if (!hasAnsi) return index;
    let result = index;
    for (const escape of message.matchAll(ANSI_SGR)) {
      if (escape.index > result) break;
      result += escape[0].length;
    }
    return result;
  }
  return {
    level: match[2], severity: ROS2_SEVERITIES[match[2]],
    start: originalIndex(match[0].length - match[1].length),
    end: originalIndex(match[0].length - 1) + 1
  };
}

function validTimestamp(text) {
  if (text === '-') return true;
  const match = RFC_TIMESTAMP.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function token(kind, start, end) {
  return { kind, start, end };
}

function sdNameEnd(text, start) {
  let cursor = start;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    // SD-NAME is printable ASCII except space, double quote, '=', and ']'.
    if (code < 33 || code > 126 || code === 34 || code === 61 || code === 93) break;
    cursor++;
  }
  return cursor > start && cursor - start <= 32 ? cursor : undefined;
}

// Scan quoted values instead of stopping at the first ']' (which may be escaped).
function structuredDataEnd(text, start) {
  if (text[start] === '-') return start + 1;
  let cursor = start;
  if (text[cursor] !== '[') return undefined;
  while (text[cursor] === '[') {
    cursor = sdNameEnd(text, cursor + 1);
    if (cursor === undefined) return undefined;
    while (text[cursor] === ' ') {
      cursor = sdNameEnd(text, cursor + 1);
      if (cursor === undefined || text.slice(cursor, cursor + 2) !== '="') return undefined;
      cursor += 2;
      while (cursor < text.length && text[cursor] !== '"') {
        if (text[cursor] === '\\') {
          if (!['\\', '"', ']'].includes(text[cursor + 1])) return undefined;
          cursor += 2;
        } else {
          if (text[cursor] === ']') return undefined;
          cursor++;
        }
      }
      if (text[cursor] !== '"') return undefined;
      cursor++;
    }
    if (text[cursor] !== ']') return undefined;
    cursor++;
  }
  return cursor;
}

function parseRfc5424(text, start) {
  const match = RFC_HEADER.exec(text.slice(start));
  if (!match || !validTimestamp(match[2])) return undefined;
  let cursor = start;
  const tokens = RFC_FIELDS.map((kind, index) => {
    const end = cursor + match[index + 1].length;
    const result = token(kind, cursor, end);
    cursor = end + 1;
    return result;
  });
  const sdEnd = structuredDataEnd(text, cursor);
  if (sdEnd === undefined || (sdEnd < text.length && text[sdEnd] !== ' ')) return undefined;
  tokens.push(token('structuredData', cursor, sdEnd));
  return { format: 'RFC5424', tokens, messageStart: sdEnd < text.length ? sdEnd + 1 : sdEnd };
}

function parseBsd(text, start) {
  const match = BSD_HEADER.exec(text.slice(start));
  if (!match) return undefined;
  const hostStart = start + match[1].length + 1;
  const tokens = [
    token('timestamp', start, start + match[1].length),
    token('hostname', hostStart, hostStart + match[2].length)
  ];
  const tagStart = start + match[0].length;
  const tag = BSD_TAG.exec(text.slice(tagStart));
  if (tag) {
    tokens.push(token('appName', tagStart, tagStart + tag[1].length));
    if (tag[2]) {
      const pidStart = tagStart + tag[1].length + 1;
      tokens.push(token('procId', pidStart, pidStart + tag[2].length));
    }
  }
  return { format: 'BSD', tokens, messageStart: tagStart + (tag ? tag[0].length : 0) };
}

/** Recognize a single syslog record. All offsets are UTF-16 columns for VS Code. */
function parseLine(text) {
  // Some decoded files retain a BOM on the first line.
  const base = text.startsWith('\uFEFF') ? 1 : 0;
  const priMatch = PRI.exec(text.slice(base));
  const priority = priMatch ? Number(priMatch[1]) : undefined;
  if (priority !== undefined && priority > 191) return undefined;
  const start = base + (priMatch ? priMatch[0].length : 0);
  const parsed = (priMatch && parseRfc5424(text, start)) || parseBsd(text, start);
  if (!parsed) return undefined;
  const ros2 = detectRos2Severity(text.slice(parsed.messageStart));
  if (ros2) {
    parsed.tokens.push(token(SEVERITIES[ros2.severity].key, parsed.messageStart + ros2.start, parsed.messageStart + ros2.end));
    parsed.ros2Severity = { level: ros2.level, severity: ros2.severity };
  }
  if (priority !== undefined) {
    parsed.priority = priority;
    parsed.severity = priority % 8;
    parsed.facility = Math.floor(priority / 8);
    parsed.priRange = { start: base, end: start };
  }
  parsed.highlightSeverity = parsed.ros2Severity?.severity ?? parsed.severity;
  return parsed;
}

module.exports = { parseLine, SEVERITIES, FACILITIES, ROS2_SEVERITIES };
