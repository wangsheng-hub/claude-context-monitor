import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { SessionMeta, SessionStats, JournalEntry, emptyStats } from './types';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

function cwdToSlug(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export class SessionWatcher extends EventEmitter {
  private stats: SessionStats | null = null;
  private sessionMeta: SessionMeta | null = null;
  private mainOffset = 0;
  private subagentOffsets = new Map<string, number>();
  private watchers: fs.FSWatcher[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private workspacePath: string;

  private pollInterval: number;

  constructor(workspacePath: string, pollInterval = 1500) {
    super();
    this.workspacePath = workspacePath;
    this.pollInterval = pollInterval;
  }

  start(): void {
    this.findSession();
    this.pollTimer = setInterval(() => this.findSession(), this.pollInterval);
  }

  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    // Unwatch stat-based watchers
    if (this.sessionMeta) {
      try { fs.unwatchFile(this.getLogPath(this.sessionMeta)); } catch { /* ignore */ }
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private debouncedParse(): void {
    // Debounce rapid fs.watch events to avoid redundant parses
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(() => this.parseIncremental(), 200);
  }

  getStats(): SessionStats | null {
    return this.stats;
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private findSession(): void {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        return;
      }
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      const candidates: SessionMeta[] = [];

      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8');
          const meta: SessionMeta = JSON.parse(raw);
          // Match workspace path (exact or parent match)
          if (this.workspacePath.startsWith(meta.cwd) || meta.cwd.startsWith(this.workspacePath)) {
            candidates.push(meta);
          }
        } catch {
          // skip corrupt files
        }
      }

      // Prefer: alive PID + most recently modified JSONL (= truly active session)
      let best: SessionMeta | null = null;
      let bestMtime = 0;
      const alive = candidates.filter(c => this.isPidAlive(c.pid));
      const pool = alive.length > 0 ? alive : candidates;
      for (const meta of pool) {
        const logPath = this.getLogPath(meta);
        let mtime = meta.startedAt; // fallback
        try {
          const st = fs.statSync(logPath);
          mtime = st.mtimeMs;
        } catch { /* file may not exist yet */ }
        if (!best || mtime > bestMtime) {
          best = meta;
          bestMtime = mtime;
        }
      }

      if (best && (!this.sessionMeta || best.sessionId !== this.sessionMeta.sessionId)) {
        this.sessionMeta = best;
        this.mainOffset = 0;
        this.subagentOffsets.clear();
        this.stats = emptyStats(best.sessionId);
        this.setupWatchers(best);
        this.parseAll();
      } else if (best && this.sessionMeta) {
        // Same session, just do incremental parse
        this.parseIncremental();
      }
    } catch {
      // ignore errors in discovery
    }
  }

  private getLogPath(meta: SessionMeta): string {
    const slug = cwdToSlug(meta.cwd);
    return path.join(PROJECTS_DIR, slug, `${meta.sessionId}.jsonl`);
  }

  private getSubagentsDir(meta: SessionMeta): string {
    const slug = cwdToSlug(meta.cwd);
    return path.join(PROJECTS_DIR, slug, meta.sessionId, 'subagents');
  }

  private setupWatchers(meta: SessionMeta): void {
    // Close old watchers
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];

    const logPath = this.getLogPath(meta);

    // fs.watch — fast but can miss events on Linux
    if (fs.existsSync(logPath)) {
      try {
        const w = fs.watch(logPath, () => this.debouncedParse());
        this.watchers.push(w);
      } catch { /* poll fallback */ }
    }

    // fs.watchFile — stat-based polling, slower but 100% reliable
    try {
      fs.watchFile(logPath, { interval: 1000 }, () => this.debouncedParse());
    } catch { /* ignore */ }

    // Watch parent dir for new subagent files
    const subDir = this.getSubagentsDir(meta);
    const parentDir = path.dirname(subDir);
    if (fs.existsSync(parentDir)) {
      try {
        const w = fs.watch(parentDir, { recursive: true }, () => this.debouncedParse());
        this.watchers.push(w);
      } catch { /* poll fallback */ }
    }
  }

  private parseAll(): void {
    if (!this.sessionMeta || !this.stats) {
      return;
    }
    this.mainOffset = 0;
    this.subagentOffsets.clear();
    this.stats = emptyStats(this.sessionMeta.sessionId);
    this.parseIncremental();
  }

  private parseIncremental(): void {
    if (!this.sessionMeta || !this.stats) {
      return;
    }

    let changed = false;

    // Parse main log
    const logPath = this.getLogPath(this.sessionMeta);
    if (fs.existsSync(logPath)) {
      const result = this.parseFile(logPath, this.mainOffset, false);
      if (result.newOffset > this.mainOffset) {
        this.mainOffset = result.newOffset;
        this.stats.totalInput += result.input;
        this.stats.totalOutput += result.output;
        this.stats.totalCacheCreation += result.cacheCreation;
        this.stats.totalCacheRead += result.cacheRead;
        this.stats.messageCount += result.messages;
        // Current context = last message's full context size
        if (result.lastInput > 0) {
          this.stats.lastInputTokens = result.lastInput;
          this.stats.lastCacheReadTokens = result.lastCacheRead;
          this.stats.lastCacheCreationTokens = result.lastCacheCreation;
        }
        changed = true;
      }
    }

    // Parse subagent logs
    const subDir = this.getSubagentsDir(this.sessionMeta);
    if (fs.existsSync(subDir)) {
      try {
        const files = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const fp = path.join(subDir, f);
          const prevOffset = this.subagentOffsets.get(fp) || 0;
          const result = this.parseFile(fp, prevOffset, true);
          if (result.newOffset > prevOffset) {
            this.subagentOffsets.set(fp, result.newOffset);
            this.stats.subagentInput += result.input;
            this.stats.subagentOutput += result.output;
            this.stats.subagentCacheCreation += result.cacheCreation;
            this.stats.subagentCacheRead += result.cacheRead;
            this.stats.subagentMessageCount += result.messages;
            changed = true;
          }
        }
      } catch {
        // ignore
      }
    }

    if (changed) {
      this.stats.lastUpdated = new Date();
      this.emit('update', this.stats);
    }
  }

  private parseFile(
    filePath: string,
    offset: number,
    _isSubagent: boolean
  ): {
    newOffset: number;
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    messages: number;
    lastInput: number;
    lastCacheRead: number;
    lastCacheCreation: number;
  } {
    const result = {
      newOffset: offset, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0,
      lastInput: 0, lastCacheRead: 0, lastCacheCreation: 0,
    };

    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= offset) {
        return result;
      }

      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);

      const text = buf.toString('utf-8');
      const lines = text.split('\n');

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const entry: JournalEntry = JSON.parse(line);
          if (entry.type === 'assistant' && entry.message?.usage) {
            const u = entry.message.usage;
            result.input += u.input_tokens || 0;
            result.output += u.output_tokens || 0;
            result.cacheCreation += u.cache_creation_input_tokens || 0;
            result.cacheRead += u.cache_read_input_tokens || 0;
            result.messages++;
            // Track last message's tokens for context window estimation
            result.lastInput = u.input_tokens || 0;
            result.lastCacheRead = u.cache_read_input_tokens || 0;
            result.lastCacheCreation = u.cache_creation_input_tokens || 0;
          }
        } catch {
          // skip malformed lines
        }
      }

      result.newOffset = stat.size;
    } catch {
      // ignore read errors
    }

    return result;
  }
}
