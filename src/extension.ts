import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const CONTROLLER_ID = 'antiquitaReview';
const AUTHOR_NAME = 'Timothée';
const CLAUDE_AUTHOR_NAME = 'Claude';
const EDITABLE_CONTEXT = 'editable';
const STAGED_REF = '';
const HEAD_REF = 'HEAD';

type Side = 'staged' | 'head';

interface ReviewComment {
  id: string;
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
  text: string;
  excerpt: string;
  response?: string;
}

interface StoredComment extends vscode.Comment {
  id: string;
}

interface GitUriParams {
  path: string;
  ref: string;
}

function parseGitUri(uri: vscode.Uri): GitUriParams | undefined {
  if (uri.scheme !== 'git') return undefined;
  try {
    return JSON.parse(uri.query) as GitUriParams;
  } catch {
    return undefined;
  }
}

function sideOf(uri: vscode.Uri): Side | undefined {
  const ref = parseGitUri(uri)?.ref;
  if (ref === STAGED_REF) return 'staged';
  if (ref === HEAD_REF) return 'head';
  return undefined;
}

function realPathOf(uri: vscode.Uri): string {
  return parseGitUri(uri)?.path ?? uri.fsPath;
}

function clampLine(document: vscode.TextDocument, line: number): number {
  return Math.min(Math.max(line, 0), document.lineCount - 1);
}

function fullLineRange(document: vscode.TextDocument, startLine: number, endLine: number): vscode.Range {
  const start = clampLine(document, startLine - 1);
  const end = clampLine(document, endLine - 1);
  return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
}

// Re-anchors a comment on its stored excerpt: if the text moved (lines added/removed
// elsewhere), finds its new position instead of trusting stale line numbers.
function locateRange(document: vscode.TextDocument, entry: ReviewComment): vscode.Range {
  const stored = fullLineRange(document, entry.startLine, entry.endLine);
  if (!entry.excerpt || document.getText(stored) === entry.excerpt) return stored;

  const offset = document.getText().indexOf(entry.excerpt);
  if (offset === -1) return stored;
  const start = document.positionAt(offset);
  const end = document.positionAt(offset + entry.excerpt.length);
  return new vscode.Range(start.line, 0, end.line, end.character);
}

function reviewFilePath(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, '.review.json') : undefined;
}

function loadComments(): ReviewComment[] {
  const file = reviewFilePath();
  if (!file || !fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveComments(comments: ReviewComment[]): void {
  const file = reviewFilePath();
  if (!file) return;
  fs.writeFileSync(file, JSON.stringify(comments, null, 2) + '\n', 'utf8');
}

function appendComment(entry: ReviewComment): void {
  const comments = loadComments();
  comments.push(entry);
  saveComments(comments);
}

function removeComment(id: string): void {
  saveComments(loadComments().filter((c) => c.id !== id));
}

function updateCommentText(id: string, text: string): void {
  saveComments(loadComments().map((c) => (c.id === id ? { ...c, text } : c)));
}

function toStoredComment(id: string, body: string, author: string, contextValue?: string): StoredComment {
  return { id, body, mode: vscode.CommentMode.Preview, author: { name: author }, contextValue };
}

function toUserComment(id: string, body: string): StoredComment {
  return toStoredComment(id, body, AUTHOR_NAME, EDITABLE_CONTEXT);
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Staged Review');
  context.subscriptions.push(controller);

  const threadsByUri = new Map<string, vscode.CommentThread[]>();

  controller.commentingRangeProvider = {
    provideCommentingRanges(document: vscode.TextDocument): vscode.Range[] | undefined {
      if (!sideOf(document.uri)) return undefined;
      return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
    },
  };

  function refreshThreads(document: vscode.TextDocument): void {
    const side = sideOf(document.uri);
    if (!side) return;
    const key = document.uri.toString();
    for (const thread of threadsByUri.get(key) ?? []) thread.dispose();

    const relativeFile = vscode.workspace.asRelativePath(realPathOf(document.uri));
    const threads = loadComments()
      .filter((entry) => entry.file === relativeFile && (entry.side ?? 'staged') === side)
      .map((entry) => {
        const range = locateRange(document, entry);
        const comments = [toUserComment(entry.id, entry.text)];
        if (entry.response) comments.push(toStoredComment(`${entry.id}:response`, entry.response, CLAUDE_AUTHOR_NAME));
        const thread = controller.createCommentThread(document.uri, range, comments);
        thread.canReply = false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        return thread;
      });
    threadsByUri.set(key, threads);
  }

  function trackThread(thread: vscode.CommentThread): void {
    const key = thread.uri.toString();
    threadsByUri.set(key, [...(threadsByUri.get(key) ?? []), thread]);
  }

  function untrackThread(thread: vscode.CommentThread): void {
    const key = thread.uri.toString();
    threadsByUri.set(key, (threadsByUri.get(key) ?? []).filter((t) => t !== thread));
  }

  function findThread(comment: vscode.Comment): vscode.CommentThread | undefined {
    for (const threads of threadsByUri.values()) {
      const thread = threads.find((t) => t.comments.includes(comment));
      if (thread) return thread;
    }
    return undefined;
  }

  function refreshAllOpenThreads(): void {
    for (const document of vscode.workspace.textDocuments) refreshThreads(document);
  }

  refreshAllOpenThreads();
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(refreshThreads));

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.review.json'));
    watcher.onDidChange(refreshAllOpenThreads);
    watcher.onDidCreate(refreshAllOpenThreads);
    watcher.onDidDelete(refreshAllOpenThreads);
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('antiquitaReview.createComment', (reply: vscode.CommentReply) => {
      const thread = reply.thread;
      const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
      const id = crypto.randomUUID();
      thread.comments = [...thread.comments, toUserComment(id, reply.text)];
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      trackThread(thread);

      const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
      const startLine = range.start.line + 1;
      const endLine = range.end.line + 1;
      appendComment({
        id,
        file: vscode.workspace.asRelativePath(realPathOf(thread.uri)),
        side: sideOf(thread.uri) ?? 'staged',
        startLine,
        endLine,
        text: reply.text,
        excerpt: document ? document.getText(fullLineRange(document, startLine, endLine)) : '',
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antiquitaReview.deleteComment', (comment: StoredComment) => {
      const thread = findThread(comment);
      if (!thread) return;
      thread.comments = thread.comments.filter((c) => c !== comment);
      removeComment(comment.id);
      if (thread.comments.length === 0) {
        untrackThread(thread);
        thread.dispose();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antiquitaReview.editComment', (comment: StoredComment) => {
      const thread = findThread(comment);
      if (!thread) return;
      thread.comments = thread.comments.map((c) => (c === comment ? { ...c, mode: vscode.CommentMode.Editing } : c));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antiquitaReview.saveComment', (comment: StoredComment) => {
      const thread = findThread(comment);
      if (!thread) return;
      const text = typeof comment.body === 'string' ? comment.body : comment.body.value;
      thread.comments = thread.comments.map((c) => ((c as StoredComment).id === comment.id ? toUserComment(comment.id, text) : c));
      updateCommentText(comment.id, text);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antiquitaReview.cancelEditComment', (comment: StoredComment) => {
      const thread = findThread(comment);
      if (!thread) return;
      const stored = loadComments().find((c) => c.id === comment.id);
      thread.comments = thread.comments.map((c) =>
        (c as StoredComment).id === comment.id ? toUserComment(comment.id, stored?.text ?? '') : c
      );
    })
  );
}

export function deactivate(): void {}
