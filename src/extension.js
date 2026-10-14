'use strict';

const vscode = require('vscode');
const { createHighlighter } = require('./highlighter');

function activate(context) {
  context.subscriptions.push(createHighlighter(vscode));
}

module.exports = { activate };
