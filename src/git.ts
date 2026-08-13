import { mkdirSync, writeFileSync } from "node:fs";

export class CommandError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${argv.join(" ")} exited ${exitCode}: ${(stderr || stdout).trim()}`);
    this.name = "CommandError";
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export async function runCommand(
  argv: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  if (argv.length === 0) throw new Error("command argv must not be empty");
  const process = Bun.spawn([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = options.timeoutMs ?? 30_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill("SIGTERM");
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`${argv[0]} timed out after ${timeoutMs}ms`);
  if (exitCode !== 0) throw new CommandError(argv, exitCode, stdout, stderr);
  return { stdout, stderr };
}

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd });
  return result.stdout.trim();
}

export async function initDisposableRepo(repoPath: string): Promise<string> {
  mkdirSync(repoPath, { recursive: true });
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.name", "sheltie-poc"]);
  await runGit(repoPath, ["config", "user.email", "sheltie-poc@localhost"]);
  await runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  writeFileSync(`${repoPath}/README.md`, "# sheltie disposable PoC repository\n");
  return commitAll(repoPath, "initialize disposable repository");
}

export async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  const commit = await runGit(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`git returned an invalid commit SHA: ${commit}`);
  return commit;
}

export async function isCleanWorktree(worktreePath: string): Promise<boolean> {
  return (await runGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])) === "";
}

export async function commitAll(worktreePath: string, message: string): Promise<string> {
  await runGit(worktreePath, ["add", "--all"]);
  const staged = await runGit(worktreePath, ["diff", "--cached", "--name-only"]);
  if (staged === "") return resolveCommit(worktreePath, "HEAD");
  await runGit(worktreePath, ["commit", "--no-gpg-sign", "-m", message]);
  return resolveCommit(worktreePath, "HEAD");
}

export async function commitExistsOnBranch(
  repoPath: string,
  commitSha: string,
  branch: string,
): Promise<boolean> {
  try {
    await runGit(repoPath, ["merge-base", "--is-ancestor", commitSha, branch]);
    return true;
  } catch (error) {
    if (error instanceof CommandError && error.exitCode === 1) return false;
    throw error;
  }
}

export async function hasMergeInProgress(worktreePath: string): Promise<boolean> {
  try {
    await resolveCommit(worktreePath, "MERGE_HEAD");
    return true;
  } catch (error) {
    if (error instanceof CommandError && error.exitCode === 128) return false;
    throw error;
  }
}
