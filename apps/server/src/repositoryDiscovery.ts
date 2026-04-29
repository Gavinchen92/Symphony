import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { RepositoryDirectorySelection, RepositoryPathSuggestion } from "@symphony/shared";

const execFileAsync = promisify(execFile);
const pathSuggestionLimit = 50;

export async function selectRepositoryDirectory(): Promise<RepositoryDirectorySelection> {
  const selectedPath = await chooseDirectoryWithSystemDialog();
  return describeRepositoryDirectory(selectedPath);
}

export async function describeRepositoryDirectory(path: string): Promise<RepositoryDirectorySelection> {
  const repositoryRoot = await gitOutput(path, ["rev-parse", "--show-toplevel"]);
  const baseBranch = (await gitOutput(repositoryRoot, ["branch", "--show-current"])) || "main";
  return {
    path: repositoryRoot,
    name: basename(repositoryRoot),
    baseBranch
  };
}

export async function listRepositoryPathSuggestions(
  repositoryPath: string,
  query: string,
  limit = pathSuggestionLimit
): Promise<RepositoryPathSuggestion[]> {
  const trackedFiles = await listTrackedFiles(repositoryPath);
  const candidates = buildPathCandidates(trackedFiles);
  const normalizedQuery = query.trim();

  return candidates
    .map((candidate) => {
      const fuzzy = scorePath(candidate.path, normalizedQuery);
      return fuzzy
        ? {
            ...candidate,
            matches: fuzzy.matches,
            score: fuzzy.score
          }
        : null;
    })
    .filter((candidate): candidate is RepositoryPathSuggestion & { score: number } => Boolean(candidate))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      if (left.path.length !== right.path.length) {
        return left.path.length - right.path.length;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, limit)
    .map(({ score: _score, ...suggestion }) => suggestion);
}

export function buildPathCandidates(files: string[]): RepositoryPathSuggestion[] {
  const candidates = new Map<string, RepositoryPathSuggestion>();

  for (const file of files) {
    if (!file) {
      continue;
    }
    candidates.set(`file:${file}`, { path: file, kind: "file", matches: [] });

    const segments = file.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const path = segments.slice(0, index).join("/");
      candidates.set(`directory:${path}`, { path, kind: "directory", matches: [] });
    }
  }

  return [...candidates.values()];
}

export function scorePath(path: string, query: string): { score: number; matches: number[] } | null {
  if (!query) {
    return { score: 0, matches: [] };
  }

  const normalizedPath = path.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const basenameStart = path.lastIndexOf("/") + 1;
  const matchCandidates = [
    findSequentialMatches(normalizedPath, normalizedQuery, 0),
    findSequentialMatches(normalizedPath, normalizedQuery, basenameStart)
  ].filter((matches): matches is number[] => Boolean(matches));

  if (matchCandidates.length === 0) {
    return null;
  }

  return matchCandidates
    .map((matches) => ({
      matches,
      score: calculateMatchScore(path, matches, basenameStart)
    }))
    .sort((left, right) => right.score - left.score)[0];
}

function findSequentialMatches(path: string, query: string, startIndex: number): number[] | null {
  const matches: number[] = [];
  let cursor = startIndex;

  for (const character of query) {
    const index = path.indexOf(character, cursor);
    if (index === -1) {
      return null;
    }
    matches.push(index);
    cursor = index + 1;
  }

  return matches;
}

function calculateMatchScore(path: string, matches: number[], basenameStart: number): number {
  return matches.reduce((total, index, matchIndex) => {
    const previous = matches[matchIndex - 1];
    const consecutiveBonus = previous !== undefined && index === previous + 1 ? 14 : 0;
    const segmentStartBonus = isPathSegmentStart(path, index) ? 18 : 0;
    const basenameBonus = index >= basenameStart ? 8 : 0;
    return total + 10 + consecutiveBonus + segmentStartBonus + basenameBonus;
  }, Math.max(0, 120 - path.length) / 10);
}

async function chooseDirectoryWithSystemDialog(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择本地 Git 仓库文件夹")'
    ]);
    const path = stdout.trim().replace(/\/+$/, "");
    if (!path) {
      throw new Error("已取消选择文件夹");
    }
    return path;
  } catch (error) {
    if (isAppleScriptCancelled(error)) {
      throw new Error("已取消选择文件夹");
    }
    throw error;
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`所选目录不是有效 Git 仓库：${formatExecError(error)}`);
  }
}

async function listTrackedFiles(repositoryPath: string): Promise<string[]> {
  const output = await gitOutput(repositoryPath, ["ls-files", "-z"]);
  return output.split("\0").filter(Boolean);
}

function isPathSegmentStart(path: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  return ["/", "-", "_", "."].includes(path[index - 1] ?? "");
}

function isAppleScriptCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: number; message?: string; stderr?: string };
  return record.code === 1 && [record.message, record.stderr].some((value) => value?.includes("-128"));
}

function formatExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { stderr?: string; message?: string };
    return record.stderr?.trim() || record.message || String(error);
  }
  return String(error);
}
